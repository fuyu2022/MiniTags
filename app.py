from __future__ import annotations

from datetime import datetime
import re
import tkinter as tk
from tkinter import filedialog
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
PROJECTS_DIR = ROOT / "projects"
STATIC_DIR = ROOT / "static"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
PROJECTS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="LoRA Dataset Tag Editor")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

class CreateProjectRequest(BaseModel):
    name: str
    initial_tags: str = ""

class SaveTagsRequest(BaseModel):
    project: str
    image_name: str
    tags: List[str]

class UpdateProjectTagsRequest(BaseModel):
    tags: str

def natural_sort_key(path: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", path.name)]

def safe_project_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Project name is required.")
    if any(c in name for c in r'\\/:*?"<>|'):
        raise HTTPException(status_code=400, detail="Project name contains invalid characters.")
    return name

def get_project_dir(project: str) -> Path:
    path = PROJECTS_DIR / safe_project_name(project)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Project not found.")
    return path

def normalize_tags(raw: str) -> List[str]:
    tags = []
    seen = set()
    for part in raw.replace("\n", ",").split(","):
        tag = part.strip()
        if tag and tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags

def read_label_tags(label: Path) -> List[str]:
    if not label.exists():
        return []

    raw = label.read_text(encoding="utf-8")
    tags = normalize_tags(raw)
    normalized = ", ".join(tags)

    if raw.strip() != normalized:
        label.write_text(normalized, encoding="utf-8")

    return tags

def parse_categorized_tags(raw: str) -> List[str]:
    tags = []
    seen = set()
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("[") and "]:" in line:
            _, raw_tags = line.split("]:", 1)
        else:
            raw_tags = line
        for tag in normalize_tags(raw_tags):
            if tag not in seen:
                seen.add(tag)
                tags.append(tag)
    return tags

def resolve_dataset_dir(dataset_dir: str) -> Path:
    path = Path(dataset_dir).expanduser().resolve()
    if not path.exists() or not path.is_dir():
        raise HTTPException(status_code=400, detail="Dataset directory does not exist.")
    return path

def assert_under_dataset(path: Path, dataset_dir: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(dataset_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid path.")
    return resolved

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/api/select-dataset-dir")
def select_dataset_dir():
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    selected = filedialog.askdirectory(title="选择 LoRA 数据集目录")
    root.destroy()
    return {"dataset_dir": str(Path(selected).resolve()) if selected else ""}

@app.post("/api/projects")
def create_project(req: CreateProjectRequest):
    name = safe_project_name(req.name)
    path = PROJECTS_DIR / name
    path.mkdir(exist_ok=True)
    (path / "tags.txt").write_text(req.initial_tags.strip(), encoding="utf-8")
    return {"project": name}

@app.get("/api/projects")
def list_projects():
    return {"projects": [p.name for p in sorted(PROJECTS_DIR.iterdir()) if p.is_dir()]}

@app.get("/api/projects/{project}/tags")
def read_project_tags(project: str):
    path = get_project_dir(project) / "tags.txt"
    if not path.exists():
        path.write_text("", encoding="utf-8")
    return {"tags": parse_categorized_tags(path.read_text(encoding="utf-8"))}

@app.post("/api/projects/{project}/tags")
def update_project_tags(project: str, req: UpdateProjectTagsRequest):
    path = get_project_dir(project) / "tags.txt"
    path.write_text(req.tags.strip(), encoding="utf-8")
    return {"saved": True, "tags": parse_categorized_tags(req.tags)}

@app.get("/api/projects/{project}/tags-raw")
def read_project_tags_raw(project: str):
    path = get_project_dir(project) / "tags.txt"
    if not path.exists():
        path.write_text("", encoding="utf-8")
    return {"text": path.read_text(encoding="utf-8")}

@app.post("/api/projects/{project}/tags-raw")
def update_project_tags_raw(project: str, req: UpdateProjectTagsRequest):
    path = get_project_dir(project) / "tags.txt"
    text = req.tags.strip()
    path.write_text(text, encoding="utf-8")
    return {"saved": True, "text": text, "tags": parse_categorized_tags(text)}

@app.get("/api/dataset")
def read_dataset(dataset_dir: str = Query(...)):
    dataset = resolve_dataset_dir(dataset_dir)
    images = []
    tag_counts = {}
    for item in sorted(dataset.iterdir(), key=natural_sort_key):
        if item.is_file() and item.suffix.lower() in IMAGE_EXTS:
            label_file = item.with_suffix(".txt")
            tags = read_label_tags(label_file)

            for tag in tags:
                tag_counts[tag] = tag_counts.get(tag, 0) + 1

            images.append({
                "image_name": item.name,
                "has_label": label_file.exists(),
                "tags": tags,
            })
    return {"dataset_dir": str(dataset), "images": images, "tag_counts": tag_counts}

@app.get("/api/image")
def get_image(dataset_dir: str, image_name: str):
    dataset = resolve_dataset_dir(dataset_dir)
    image = assert_under_dataset(dataset / image_name, dataset)
    if not image.exists() or image.suffix.lower() not in IMAGE_EXTS:
        raise HTTPException(status_code=404, detail="Image not found.")
    return FileResponse(image)

@app.get("/api/labels")
def get_labels(dataset_dir: str, image_name: str):
    dataset = resolve_dataset_dir(dataset_dir)
    image = assert_under_dataset(dataset / image_name, dataset)
    if not image.exists() or image.suffix.lower() not in IMAGE_EXTS:
        raise HTTPException(status_code=404, detail="Image not found.")
    label = image.with_suffix(".txt")
    return {"tags": read_label_tags(label)}

@app.post("/api/labels")
def save_labels(req: SaveTagsRequest, dataset_dir: str):
    get_project_dir(req.project)
    dataset = resolve_dataset_dir(dataset_dir)
    image = assert_under_dataset(dataset / req.image_name, dataset)
    if not image.exists() or image.suffix.lower() not in IMAGE_EXTS:
        raise HTTPException(status_code=404, detail="Image not found.")
    cleaned = normalize_tags(",".join(req.tags))
    label = image.with_suffix(".txt")
    label.write_text(", ".join(cleaned), encoding="utf-8")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[SAVE] {now} -> {label}\n"
    with open(ROOT / "save_log.txt", "a", encoding="utf-8") as f:
        f.write(log_line)
    print(log_line.strip())
    return {"saved": True, "label_file": str(label), "tags": cleaned}
