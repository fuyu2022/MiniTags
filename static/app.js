const state = {
  project: "",
  datasetDir: "",
  images: [],
  index: 0,
  tags: [],
  dirty: false,
  tagCategories: {},
  categoryOrder: [],
  currentCategory: "",
  exclusiveRules: {},
  tagCounts: {},
  savedTags: [],
};

const $ = (id) => document.getElementById(id);

function setSaveState(text) {
  $("saveState").textContent = text ? ` ${text}` : "";
}

function uniqueTags(tags) {
  const seen = new Set();
  const out = [];

  for (const tag of tags) {
    const clean = String(tag).trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function getTagCount(tag) {
  return Number(state.tagCounts[tag] || 0);
}

function updateTagCount(tag, delta) {
  const next = getTagCount(tag) + delta;

  if (next > 0) {
    state.tagCounts[tag] = next;
  } else {
    delete state.tagCounts[tag];
  }
}

function syncPaletteCounts() {
  renderPalette(state.tagCategories[state.currentCategory] || []);
}

function applySavedTagCountDelta(previousTags, nextTags) {
  const previous = new Set(uniqueTags(previousTags));
  const next = new Set(uniqueTags(nextTags));

  for (const tag of previous) {
    if (!next.has(tag)) {
      updateTagCount(tag, -1);
    }
  }

  for (const tag of next) {
    if (!previous.has(tag)) {
      updateTagCount(tag, 1);
    }
  }
}

function parseTagWithGroup(raw) {
  const text = String(raw || "").trim();

  if (!text) {
    return { tag: "", group: "" };
  }

  const match = text.match(/^(.+):([^:]+)$/);

  if (!match) {
    return { tag: text, group: "" };
  }

  return {
    tag: match[1].trim(),
    group: match[2].trim(),
  };
}

function parseTagText(text) {
  const categories = {};
  const order = [];
  const exclusiveRules = {};

  const ensureCategory = (name) => {
    const clean = String(name || "未分类").trim() || "未分类";

    if (!categories[clean]) {
      categories[clean] = [];
      order.push(clean);
    }

    return clean;
  };

  const addTags = (category, rawTags) => {
    const name = ensureCategory(category);
    const parts = String(rawTags || "").replace(/\n/g, ",").split(",");

    for (const part of parts) {
      const parsed = parseTagWithGroup(part);

      if (!parsed.tag) {
        continue;
      }

      categories[name] = uniqueTags([...categories[name], parsed.tag]);

      if (parsed.group) {
        exclusiveRules[parsed.tag] = {
          category: name,
          group: parsed.group,
        };
      }
    }
  };

  const lines = String(text || "").split(/\r?\n/);

  for (const line of lines) {
    const cleanLine = line.trim();

    if (!cleanLine) {
      continue;
    }

    const match = cleanLine.match(/^\[(.+?)\]\s*:\s*(.*)$/);

    if (match) {
      addTags(match[1], match[2]);
    } else {
      addTags("未分类", cleanLine);
    }
  }

  if (!order.length) {
    ensureCategory("未分类");
  }

  return { categories, order, exclusiveRules };
}

function serializeTagText(categories, order) {
  return order
    .map((category) => {
      const parts = uniqueTags(categories[category] || []).map((tag) => {
        const rule = state.exclusiveRules[tag];

        if (rule && rule.category === category && rule.group) {
          return `${tag}:${rule.group}`;
        }

        return tag;
      });

      return `[${category}]:${parts.join(", ")}`;
    })
    .join("\n");
}

function validateExclusiveTags() {
  const buckets = new Map();

  for (const tag of state.tags) {
    const rule = state.exclusiveRules[tag];

    if (!rule || !rule.group) {
      continue;
    }

    const key = `${rule.category}::${rule.group}`;

    if (!buckets.has(key)) {
      buckets.set(key, []);
    }

    buckets.get(key).push(tag);
  }

  const removeSet = new Set();
  const messages = [];

  for (const [key, tags] of buckets.entries()) {
    if (tags.length <= 1) {
      continue;
    }

    const [category, group] = key.split("::");
    const keep = tags[0];
    const remove = tags.slice(1);

    remove.forEach((tag) => removeSet.add(tag));

    messages.push(
      `[${category} / ${group}]\n重复：${tags.join(", ")}\n保留：${keep}\n删除：${remove.join(", ")}`
    );
  }

  if (!removeSet.size) {
    return false;
  }

  state.tags = state.tags.filter((tag) => !removeSet.has(tag));
  state.dirty = true;

  renderLabels();
  setSaveState("检测到互斥标签，已自动删除，未保存");

  alert(
    "检测到互斥标签重复，已自动删除多余标签：\n\n" +
    messages.join("\n\n")
  );

  return true;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = data.detail || msg;
    } catch (_) {}
    throw new Error(msg);
  }

  return res.json();
}

function makePaletteTag(tag) {
  const el = document.createElement("div");
  el.className = "tag";
  el.draggable = true;
  el.title = `${tag} (${getTagCount(tag)})`;

  const text = document.createElement("span");
  text.className = "tag-name";
  text.textContent = tag;

  const count = document.createElement("span");
  count.className = "tag-count";
  count.textContent = getTagCount(tag);

  el.appendChild(text);
  el.appendChild(count);

  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", tag);
    e.dataTransfer.effectAllowed = "copy";
  });

  return el;
}

function renderPalette(tags) {
  const box = $("tagPalette");
  box.innerHTML = "";
  tags.forEach((tag) => box.appendChild(makePaletteTag(tag)));
}

function renderCategoryNav() {
  const nav = $("categoryNav");
  nav.innerHTML = "";

  state.categoryOrder.forEach((category) => {
    const btn = document.createElement("button");
    const isActive = category === state.currentCategory;
    const count = (state.tagCategories[category] || []).length;

    btn.type = "button";
    btn.className =
      "category-tab" + (isActive ? " active" : "") + (count ? "" : " empty");
    btn.textContent = `${category} (${count})`;

    btn.addEventListener("click", () => switchCategory(category));

    nav.appendChild(btn);
  });
}

function syncTextareaToCurrentCategory() {
  if (!state.currentCategory) {
    return;
  }

  const tags = [];
  const parts = $("initialTags").value.replace(/\n/g, ",").split(",");

  for (const part of parts) {
    const parsed = parseTagWithGroup(part);

    if (!parsed.tag) {
      continue;
    }

    tags.push(parsed.tag);

    if (parsed.group) {
      state.exclusiveRules[parsed.tag] = {
        category: state.currentCategory,
        group: parsed.group,
      };
    } else if (
      state.exclusiveRules[parsed.tag] &&
      state.exclusiveRules[parsed.tag].category === state.currentCategory
    ) {
      delete state.exclusiveRules[parsed.tag];
    }
  }

  state.tagCategories[state.currentCategory] = uniqueTags(tags);
}

function renderCurrentCategory() {
  const category = state.currentCategory || state.categoryOrder[0] || "未分类";

  if (!state.tagCategories[category]) {
    state.tagCategories[category] = [];
    state.categoryOrder.push(category);
  }

  state.currentCategory = category;

  const tags = state.tagCategories[category] || [];

  renderCategoryNav();
  renderPalette(tags);

  $("initialTags").classList.add("category-mode");

  $("initialTags").value = tags
    .map((tag) => {
      const rule = state.exclusiveRules[tag];

      if (rule && rule.category === category && rule.group) {
        return `${tag}:${rule.group}`;
      }

      return tag;
    })
    .join(", ");
}

function switchCategory(category) {
  syncTextareaToCurrentCategory();
  state.currentCategory = category;
  renderCurrentCategory();
}

function makeLabelTag(tag) {
  const el = document.createElement("div");
  el.className = "tag in-label";

  const text = document.createElement("span");
  text.textContent = tag;

  const remove = document.createElement("button");
  remove.className = "remove";
  remove.textContent = "×";
  remove.title = "删除";

  remove.addEventListener("click", () => {
    state.tags = state.tags.filter((t) => t !== tag);
    state.dirty = true;
    renderLabels();
    setSaveState("未保存");
  });

  el.appendChild(text);
  el.appendChild(remove);

  return el;
}

function renderLabels() {
  const zone = $("labelDropZone");
  zone.innerHTML = "";

  if (!state.tags.length) {
    const ph = document.createElement("span");
    ph.className = "placeholder";
    ph.textContent = "把上方 tag 拖到这里，或手动输入后按 Enter";
    zone.appendChild(ph);
    return;
  }

  state.tags.forEach((tag) => zone.appendChild(makeLabelTag(tag)));
}

function addTag(tag) {
  const clean = String(tag).trim();

  if (!clean || state.tags.includes(clean)) {
    return;
  }

  state.tags.push(clean);
  state.dirty = true;

  renderLabels();
  validateExclusiveTags();

  setSaveState("未保存");
}

async function selectProject(name) {
  state.project = name;

  if (!name) {
    state.tagCategories = {};
    state.categoryOrder = [];
    state.currentCategory = "";
    state.exclusiveRules = {};

    renderPalette([]);
    renderCategoryNav();

    $("initialTags").value = "";
    $("initialTags").classList.remove("category-mode");
    return;
  }

  const data = await api(`/api/projects/${encodeURIComponent(name)}/tags-raw`);
  const parsed = parseTagText(data.text || "");

  state.tagCategories = parsed.categories;
  state.categoryOrder = parsed.order;
  state.exclusiveRules = parsed.exclusiveRules || {};
  state.currentCategory = state.categoryOrder[0] || "未分类";

  renderCurrentCategory();
}

async function saveProjectTags() {
  if (!state.project) {
    alert("请先选择项目。");
    return;
  }

  syncTextareaToCurrentCategory();

  const text = serializeTagText(state.tagCategories, state.categoryOrder);

  await api(`/api/projects/${encodeURIComponent(state.project)}/tags-raw`, {
    method: "POST",
    body: JSON.stringify({ tags: text }),
  });

  renderCurrentCategory();
  alert("项目标签已保存。");
}

async function createProject() {
  const name = $("projectName").value.trim();

  if (!name) {
    alert("请输入项目名。");
    return;
  }

  await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name,
      initial_tags: $("initialTags").value,
    }),
  });

  await refreshProjects();

  $("projectSelect").value = name;
  await selectProject(name);
}

async function refreshProjects() {
  const data = await api("/api/projects");
  const select = $("projectSelect");
  const current = select.value;

  select.innerHTML = `<option value="">选择项目</option>`;

  data.projects.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  if (current) {
    select.value = current;
  }
}

async function chooseDatasetDirFromBackend() {
  const data = await api("/api/select-dataset-dir");

  if (!data.dataset_dir) {
    return "";
  }

  $("datasetDir").value = data.dataset_dir;
  return data.dataset_dir;
}

async function loadDataset() {
  let dir = $("datasetDir").value.trim();

  if (!state.project) {
    alert("请先创建或选择项目。");
    return;
  }

  if (!dir) {
    dir = await chooseDatasetDirFromBackend();

    if (!dir) {
      return;
    }
  }

  const data = await api(`/api/dataset?dataset_dir=${encodeURIComponent(dir)}`);

  state.datasetDir = data.dataset_dir;
  state.images = data.images;
  state.tagCounts = data.tag_counts || {};
  state.index = 0;
  state.savedTags = [];

  syncPaletteCounts();

  if (state.images.length) {
    await loadCurrentImage();
  } else {
    renderImageList();
    alert("该目录下没有支持的图片文件。");
  }
}

function renderImageList() {
  const list = $("imageList");
  list.innerHTML = "";

  state.images.forEach((img, idx) => {
    const item = document.createElement("div");
    const isActive = idx === state.index;

    item.className = "image-item" + (isActive ? " active" : "");
    item.textContent = `${idx + 1}. ${img.image_name}`;

    item.addEventListener("click", async () => {
      if (!(await guardUnsaved())) {
        return;
      }

      state.index = idx;
      await loadCurrentImage();
    });

    list.appendChild(item);
  });
}

async function loadCurrentImage() {
  const img = state.images[state.index];

  if (!img) {
    return;
  }

  $("counter").textContent = `${state.index + 1} / ${state.images.length}`;
  $("imageName").textContent = img.image_name;

  const imageUrl =
    `/api/image?dataset_dir=${encodeURIComponent(state.datasetDir)}` +
    `&image_name=${encodeURIComponent(img.image_name)}` +
    `&t=${Date.now()}`;

  const imageView = $("imageView");
  imageView.src = imageUrl;
  imageView.style.display = "block";

  const labels = Array.isArray(img.tags)
    ? { tags: img.tags }
    : await api(
        `/api/labels?dataset_dir=${encodeURIComponent(state.datasetDir)}` +
          `&image_name=${encodeURIComponent(img.image_name)}`
      );

  state.tags = uniqueTags(labels.tags);
  state.savedTags = [...state.tags];
  img.tags = [...state.tags];
  state.dirty = false;

  renderLabels();

  const changedByExclusiveCheck = validateExclusiveTags();

  renderImageList();

  if (!changedByExclusiveCheck) {
    setSaveState("");
  }
}

async function saveCurrent() {
  const img = state.images[state.index];

  if (!img) {
    return;
  }

  const data = await api(`/api/labels?dataset_dir=${encodeURIComponent(state.datasetDir)}`, {
    method: "POST",
    body: JSON.stringify({
      project: state.project,
      image_name: img.image_name,
      tags: state.tags,
    }),
  });

  const savedTags = uniqueTags(data.tags || state.tags);
  applySavedTagCountDelta(state.savedTags, savedTags);

  state.tags = savedTags;
  state.savedTags = [...savedTags];
  img.tags = [...savedTags];
  img.has_label = true;

  state.dirty = false;
  renderLabels();
  syncPaletteCounts();
  setSaveState("已保存到原 txt");
}

async function guardUnsaved() {
  if (!state.dirty) {
    return true;
  }

  const ok = confirm(
    "当前图片有未保存修改，是否保存后继续？点击取消则留在当前图片。"
  );

  if (!ok) {
    return false;
  }

  await saveCurrent();
  return true;
}

async function nextImage() {
  if (!state.images.length) {
    return;
  }

  if (state.dirty) {
    await saveCurrent();
  }

  state.index = Math.min(state.images.length - 1, state.index + 1);
  await loadCurrentImage();
}

async function prevImage() {
  if (!state.images.length) {
    return;
  }

  if (state.dirty) {
    await saveCurrent();
  }

  state.index = Math.max(0, state.index - 1);
  await loadCurrentImage();
}

function setupImageDrop() {
  const box = document.querySelector(".image-box");

  if (!box) {
    return;
  }

  box.addEventListener("dragover", (e) => {
    e.preventDefault();
    box.classList.add("drag-over");
    e.dataTransfer.dropEffect = "copy";
  });

  box.addEventListener("dragleave", () => {
    box.classList.remove("drag-over");
  });

  box.addEventListener("drop", (e) => {
    e.preventDefault();
    box.classList.remove("drag-over");

    addTag(e.dataTransfer.getData("text/plain"));
  });
}

function setupDropZone() {
  const zone = $("labelDropZone");

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag-over");
    e.dataTransfer.dropEffect = "copy";
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("drag-over");
  });

  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag-over");

    addTag(e.dataTransfer.getData("text/plain"));
  });
}

function setupManualAdd() {
  const input = $("manualTag");

  const add = () => {
    addTag(input.value);
    input.value = "";
    input.focus();
  };

  $("addManualBtn").addEventListener("click", add);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
}

function setupProjectTagTextarea() {
  $("initialTags").addEventListener("input", () => {
    syncTextareaToCurrentCategory();
    renderCategoryNav();
    renderPalette(state.tagCategories[state.currentCategory] || []);
  });
}

function setupShortcuts() {
  window.addEventListener("keydown", async (e) => {
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(e.target.tagName)) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      await saveCurrent();
    } else if (e.key === "ArrowRight") {
      await nextImage();
    } else if (e.key === "ArrowLeft") {
      await prevImage();
    }
  });
}

async function boot() {
  $("createProjectBtn").addEventListener("click", createProject);
  $("projectSelect").addEventListener("change", (e) =>
    selectProject(e.target.value)
  );
  $("loadDatasetBtn").addEventListener("click", loadDataset);
  $("saveBtn").addEventListener("click", saveCurrent);
  $("nextBtn").addEventListener("click", nextImage);
  $("prevBtn").addEventListener("click", prevImage);
  $("saveProjectTagsBtn").addEventListener("click", saveProjectTags);

  setupImageDrop();
  setupDropZone();
  setupManualAdd();
  setupProjectTagTextarea();
  setupShortcuts();

  await refreshProjects();
}

boot().catch((err) => alert(err.message));
