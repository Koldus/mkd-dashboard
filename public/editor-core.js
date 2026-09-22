// ── editor-core.js ────────────────────────────────────────────────────────────
// Shared file tree, tab management, and CRUD logic.
// Consumed by project.html (projects) and editor.html (notebook, ideas, …).
// ─────────────────────────────────────────────────────────────────────────────

import { Editor }    from 'https://esm.sh/@tiptap/core@2'
import StarterKit    from 'https://esm.sh/@tiptap/starter-kit@2'
import Image         from 'https://esm.sh/@tiptap/extension-image@2'
import Link          from 'https://esm.sh/@tiptap/extension-link@2'
import TaskList      from 'https://esm.sh/@tiptap/extension-task-list@2'
import TaskItem      from 'https://esm.sh/@tiptap/extension-task-item@2'
import Table         from 'https://esm.sh/@tiptap/extension-table@2'
import TableRow      from 'https://esm.sh/@tiptap/extension-table-row@2'
import TableHeader   from 'https://esm.sh/@tiptap/extension-table-header@2'
import TableCell     from 'https://esm.sh/@tiptap/extension-table-cell@2'
import { Markdown }  from 'https://esm.sh/tiptap-markdown@0.8'

// Image node extended with width + height attributes
const CustomImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width:  { default: null, parseHTML: el => el.getAttribute('width'),  renderHTML: a => a.width  ? { width:  a.width  } : {} },
      height: { default: null, parseHTML: el => el.getAttribute('height'), renderHTML: a => a.height ? { height: a.height } : {} },
    };
  },
});

// ── SVG icon constants ────────────────────────────────────────────────────────
const FILE_ICON   = `<svg class="nav-tree-icon nav-tree-icon--file" width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 2h6l2 2v7H1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7 2v2h2" stroke="currentColor" stroke-width="1.2"/></svg>`;
const FOLDER_ICON = `<svg class="nav-tree-icon nav-tree-icon--folder" width="13" height="10" viewBox="0 0 13 10" fill="none"><path d="M0.5 2.5h4l1-1.5h7v8h-12z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="currentColor" fill-opacity="0.12"/></svg>`;

// ── Pure helpers ──────────────────────────────────────────────────────────────
export function humanize(str) {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function labelForFile(relPath) {
  return humanize(relPath.split('/').pop().replace('.md', ''));
}

// ── Image path helpers ────────────────────────────────────────────────────────
// Relative image paths are rewritten to /files/:root/... before being fed to
// the editor so WYSIWYG can load them. Reverted to relative paths on save.
function imgBaseUrl(root, savePath) {
  const lastSlash = savePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? savePath.slice(0, lastSlash) : '';
  return `/files/${root}/${dir ? dir + '/' : ''}`;
}

function resolveImages(md, baseUrl) {
  // markdown syntax: ![alt](relative)
  let r = md.replace(/!\[([^\]]*)\]\((?!https?:\/\/|\/|data:)([^)\s]+)\)/g,
    (_, alt, src) => `![${alt}](${baseUrl}${src})`);
  // HTML img tags: <img ... src="relative" ...>
  r = r.replace(/<img\b([^>]*?)src="(?!https?:\/\/|\/|data:)([^"]+)"/gi,
    (_, pre, src) => `<img${pre}src="${baseUrl}${src}"`);
  return r;
}

function unresolveImages(md, baseUrl) {
  const esc = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // markdown syntax
  let r = md.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${esc}([^)\\s]+)\\)`, 'g'),
    (_, alt, src) => `![${alt}](${src})`);
  // HTML img tags
  r = r.replace(new RegExp(`<img\\b([^>]*?)src="${esc}([^"]+)"`, 'gi'),
    (_, pre, src) => `<img${pre}src="${src}"`);
  return r;
}

// ── TipTap pane setup ─────────────────────────────────────────────────────────
export function setupTuiPane(pane, tab, { markdown, root, savePath, saveFn, imageBaseUrl, openFileFn = null, filesUrl = null }) {
  pane.classList.add('editor-pane-editable');
  pane.innerHTML = '';

  // ── Save bar ──────────────────────────────────────────────────────────────
  const saveBar = document.createElement('div');
  saveBar.className = 'editor-save-bar';
  saveBar.innerHTML =
    `<span class="editor-save-status">All changes saved</span>` +
    `<button class="editor-save-btn" disabled>Save</button>`;

  // ── Layout ────────────────────────────────────────────────────────────────
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'editor-body-wrap';

  const tipWrap = document.createElement('div');
  tipWrap.className = 'tiptap-wrap';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'tiptap-toolbar';
  toolbar.innerHTML =
    `<button class="tt-btn" data-cmd="h1">H1</button>` +
    `<button class="tt-btn" data-cmd="h2">H2</button>` +
    `<button class="tt-btn" data-cmd="h3">H3</button>` +
    `<span class="tt-sep"></span>` +
    `<button class="tt-btn tt-bold" data-cmd="bold" title="Bold">B</button>` +
    `<button class="tt-btn tt-italic" data-cmd="italic" title="Italic">I</button>` +
    `<button class="tt-btn tt-strike" data-cmd="strike" title="Strike">S</button>` +
    `<span class="tt-sep"></span>` +
    `<button class="tt-btn" data-cmd="code" title="Inline code">\`</button>` +
    `<button class="tt-btn" data-cmd="codeBlock" title="Code block">&lt;/&gt;</button>` +
    `<button class="tt-btn" data-cmd="blockquote" title="Blockquote">❝</button>` +
    `<span class="tt-sep"></span>` +
    `<button class="tt-btn" data-cmd="ul" title="Bullet list">• –</button>` +
    `<button class="tt-btn" data-cmd="ol" title="Ordered list">1.</button>` +
    `<button class="tt-btn" data-cmd="task" title="Task list">☐</button>` +
    `<span class="tt-sep"></span>` +
    `<button class="tt-btn" data-cmd="hr" title="Horizontal rule">—</button>` +
    `<button class="tt-btn" data-cmd="link" title="Insert link">⊕ link</button>` +
    `<button class="tt-btn" data-cmd="image" title="Insert image">⊕ img</button>` +
    `<button class="tt-btn" data-cmd="table" title="Table">⊕ table</button>` +
    `<span class="tt-sep tt-sep-flex"></span>` +
    `<button class="tt-btn" data-cmd="source" title="Toggle markdown source">MD</button>`;

  // Image insert form (inline, below toolbar)
  const imgForm = document.createElement('div');
  imgForm.className = 'tiptap-img-form';
  imgForm.hidden = true;
  imgForm.innerHTML =
    `<input class="tt-input" id="tt-src" placeholder="filename.png" autocomplete="off" />` +
    `<input class="tt-input tt-input-sm" id="tt-width" placeholder="width px" type="number" />` +
    `<input class="tt-input" id="tt-alt" placeholder="alt text" autocomplete="off" />` +
    `<button class="tt-btn tt-btn-primary" id="tt-img-ok">Insert</button>` +
    `<button class="tt-btn" id="tt-img-cancel">✕</button>`;

  // Link insert form (inline, below toolbar)
  const linkForm = document.createElement('div');
  linkForm.className = 'tiptap-link-form';
  linkForm.hidden = true;
  linkForm.innerHTML =
    `<div class="tt-link-row">` +
      `<input class="tt-input" id="tt-link-url" placeholder="URL or page path…" autocomplete="off" />` +
      `<button class="tt-btn tt-btn-primary" id="tt-link-ok">Set link</button>` +
      `<button class="tt-btn" id="tt-link-remove">Remove</button>` +
      `<button class="tt-btn" id="tt-link-cancel">✕</button>` +
    `</div>` +
    `<div class="tt-link-pages" id="tt-link-pages" hidden></div>`;

  // Table menu (floating dropdown)
  const tableMenu = document.createElement('div');
  tableMenu.className = 'tiptap-table-menu';
  tableMenu.hidden = true;
  tableMenu.innerHTML =
    `<button class="tt-btn tt-menu-item" data-tbl="insert">Insert table (with header)</button>` +
    `<button class="tt-btn tt-menu-item" data-tbl="insertNoHeader">Insert table (no header)</button>` +
    `<div class="tt-menu-sep"></div>` +
    `<button class="tt-btn tt-menu-item tt-tbl-ctx" data-tbl="addColBefore">Add column before</button>` +
    `<button class="tt-btn tt-menu-item tt-tbl-ctx" data-tbl="addColAfter">Add column after</button>` +
    `<button class="tt-btn tt-menu-item tt-tbl-ctx" data-tbl="addRowBefore">Add row before</button>` +
    `<button class="tt-btn tt-menu-item tt-tbl-ctx" data-tbl="addRowAfter">Add row after</button>` +
    `<div class="tt-menu-sep"></div>` +
    `<button class="tt-btn tt-menu-item tt-tbl-ctx" data-tbl="deleteCol">Delete column</button>` +
    `<button class="tt-btn tt-menu-item tt-tbl-ctx" data-tbl="deleteRow">Delete row</button>` +
    `<button class="tt-btn tt-menu-item tt-tbl-ctx" data-tbl="deleteTable">Delete table</button>`;
  document.body.appendChild(tableMenu);

  // Editor content area
  const contentEl = document.createElement('div');
  contentEl.className = 'tiptap-content';

  // Source textarea
  const sourceEl = document.createElement('textarea');
  sourceEl.className = 'tiptap-source';
  sourceEl.hidden = true;
  sourceEl.spellcheck = false;

  tipWrap.append(toolbar, imgForm, linkForm, contentEl, sourceEl);

  // ToC sidebar
  const tocEl = document.createElement('nav');
  tocEl.className = 'editor-toc';
  tocEl.style.display = 'none';

  bodyWrap.append(tipWrap, tocEl);
  pane.append(saveBar, bodyWrap);

  // ── TipTap editor ─────────────────────────────────────────────────────────
  const baseUrl = imageBaseUrl !== undefined ? imageBaseUrl : imgBaseUrl(root, savePath);

  // Strip YAML frontmatter before feeding to TipTap; restore on save.
  function splitFrontmatter(md) {
    const m = (md || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return m ? { fm: m[0], body: md.slice(m[0].length) } : { fm: '', body: md || '' };
  }
  let { fm: frontmatter, body: bodyMarkdown } = splitFrontmatter(markdown);

  const editor = new Editor({
    element: contentEl,
    extensions: [
      StarterKit,
      CustomImage,
      Link.configure({ openOnClick: false, validate: href => !!href, isAllowedUri: () => true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
      Markdown.configure({ html: true, tightLists: true }),
    ],
    content: resolveImages(bodyMarkdown, baseUrl),
    editorProps: { attributes: { spellcheck: 'false' } },
  });

  pane._editor = editor;

  // ── Save / dirty ──────────────────────────────────────────────────────────
  const statusEl = saveBar.querySelector('.editor-save-status');
  const saveBtn  = saveBar.querySelector('.editor-save-btn');
  let dirty = false;
  let inSourceMode = false;

  function setDirty(next) {
    if (dirty === next) return;
    dirty = next;
    statusEl.textContent = next ? 'Unsaved changes' : 'All changes saved';
    statusEl.classList.toggle('dirty', next);
    saveBtn.disabled = !next;
    tab.classList.toggle('tab-dirty', next);
  }

  // tiptap-markdown serializes images as ![alt](src), losing width/height.
  // Walk the doc and replace markdown img syntax with <img> HTML for any node
  // that carries width or height so the attributes survive the save round-trip.
  function getMarkdown() {
    let md = editor.storage.markdown.getMarkdown();
    editor.state.doc.descendants(node => {
      if (node.type.name !== 'image') return;
      const { src, alt, width, height } = node.attrs;
      if (!width && !height) return;
      const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const parts = [`src="${src}"`];
      if (alt)    parts.push(`alt="${alt}"`);
      if (width)  parts.push(`width="${width}"`);
      if (height) parts.push(`height="${height}"`);
      md = md.replace(
        new RegExp(`!\\[[^\\]]*\\]\\(${escapedSrc}[^)]*\\)`, 'g'),
        `<img ${parts.join(' ')} />`
      );
    });
    return md;
  }

  // The exact string a save would write — also the basis for the dirty comparison, so that
  // "unchanged" means "would write the same bytes" rather than "hasn't been touched".
  function currentMarkdown() {
    return inSourceMode
      ? unresolveImages(sourceEl.value, baseUrl)
      : frontmatter + unresolveImages(getMarkdown(), baseUrl);
  }

  // Compared against serializer output rather than the raw file: TipTap normalises list
  // markers, escaping and image syntax on load, so the file on disk is frequently not
  // byte-identical to what a save would produce even before any edit.
  // null means the initial doc couldn't be serialized; refreshDirty then falls back to the
  // old latch behaviour rather than risk clearing a genuine unsaved state.
  let baselineMd = null;
  try { baselineMd = currentMarkdown(); } catch { /* leave null */ }

  // Recomputing means running the markdown serializer, which is too much work per keystroke.
  // An edit flips the dot on immediately (cheap, and almost always right); the debounced
  // comparison is what can flip it back off after an undo.
  let dirtyCheckTimer = null;
  function refreshDirty() {
    clearTimeout(dirtyCheckTimer);
    dirtyCheckTimer = null;
    if (baselineMd === null) return;
    try { setDirty(currentMarkdown() !== baselineMd); } catch { /* leave the flag as-is */ }
  }
  function scheduleDirtyCheck() {
    setDirty(true);
    clearTimeout(dirtyCheckTimer);
    dirtyCheckTimer = setTimeout(refreshDirty, 250);
  }

  function save() {
    const md = currentMarkdown();
    const finish = () => {
      baselineMd = md;
      clearTimeout(dirtyCheckTimer);
      dirtyCheckTimer = null;
      setDirty(false);
    };
    if (saveFn) {
      saveFn(md).then(finish).catch(err => alert(err.message));
    } else {
      fetch('/api/project-file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, path: savePath, content: md }),
      }).then(r => r.json()).then(d => {
        if (d.error) { alert(d.error); return; }
        finish();
      });
    }
  }

  saveBtn.addEventListener('click', save);
  pane.addEventListener('keydown', e => {
    // Flush any pending debounce first, so Ctrl+S right after an undo doesn't rewrite
    // identical content — and, right after a keystroke, doesn't skip a real save.
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); refreshDirty(); if (dirty) save(); }
  });

  // ── Toolbar ───────────────────────────────────────────────────────────────
  function updateToolbar() {
    const inTable = editor.isActive('table');
    const state = {
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      bold: editor.isActive('bold'), italic: editor.isActive('italic'),
      strike: editor.isActive('strike'), code: editor.isActive('code'),
      codeBlock: editor.isActive('codeBlock'), blockquote: editor.isActive('blockquote'),
      ul: editor.isActive('bulletList'), ol: editor.isActive('orderedList'),
      task: editor.isActive('taskList'),
      table: inTable,
    };
    toolbar.querySelectorAll('[data-cmd]').forEach(b =>
      b.classList.toggle('active', !!state[b.dataset.cmd])
    );
    tableMenu.querySelectorAll('.tt-tbl-ctx').forEach(b =>
      b.toggleAttribute('data-disabled', !inTable)
    );
  }

  toolbar.addEventListener('mousedown', e => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    const c = editor.chain().focus();
    switch (btn.dataset.cmd) {
      case 'h1':         c.toggleHeading({ level: 1 }).run(); break;
      case 'h2':         c.toggleHeading({ level: 2 }).run(); break;
      case 'h3':         c.toggleHeading({ level: 3 }).run(); break;
      case 'bold':       c.toggleBold().run(); break;
      case 'italic':     c.toggleItalic().run(); break;
      case 'strike':     c.toggleStrike().run(); break;
      case 'code':       c.toggleCode().run(); break;
      case 'codeBlock':  c.toggleCodeBlock().run(); break;
      case 'blockquote': c.toggleBlockquote().run(); break;
      case 'ul':         c.toggleBulletList().run(); break;
      case 'ol':         c.toggleOrderedList().run(); break;
      case 'task':       c.toggleTaskList().run(); break;
      case 'hr':         c.setHorizontalRule().run(); break;
      case 'link':       handleLink(); break;
      case 'image':      toggleImgForm(); break;
      case 'table':      toggleTableMenu(btn); break;
      case 'source':     toggleSource(); break;
    }
    updateToolbar();
  });

  editor.on('selectionUpdate', () => { updateToolbar(); updateLinkTooltip(); });
  editor.on('update', () => { scheduleDirtyCheck(); updateToc(); updateToolbar(); updateLinkTooltip(); });
  sourceEl.addEventListener('input', scheduleDirtyCheck);

  // ── Image insert ──────────────────────────────────────────────────────────
  function toggleImgForm() {
    imgForm.hidden = !imgForm.hidden;
    if (!imgForm.hidden) imgForm.querySelector('#tt-src').focus();
  }

  function insertImage() {
    const src   = imgForm.querySelector('#tt-src').value.trim();
    const width = imgForm.querySelector('#tt-width').value.trim();
    const alt   = imgForm.querySelector('#tt-alt').value.trim();
    if (!src) return;
    editor.chain().focus().setImage({
      src: baseUrl + src, alt: alt || undefined,
      ...(width ? { width } : {}),
    }).run();
    imgForm.hidden = true;
    ['#tt-src', '#tt-width', '#tt-alt'].forEach(sel => { imgForm.querySelector(sel).value = ''; });
  }

  imgForm.querySelector('#tt-img-ok').addEventListener('click', insertImage);
  imgForm.querySelector('#tt-img-cancel').addEventListener('click', () => { imgForm.hidden = true; });
  imgForm.querySelector('#tt-src').addEventListener('keydown', e => { if (e.key === 'Enter') insertImage(); });

  // ── Table menu ────────────────────────────────────────────────────────────
  editor.on('destroy', () => tableMenu.remove());

  function toggleTableMenu(triggerBtn) {
    if (!tableMenu.hidden) { tableMenu.hidden = true; return; }
    updateToolbar();
    const rect = triggerBtn.getBoundingClientRect();
    tableMenu.style.left = rect.left + 'px';
    tableMenu.style.top  = (rect.bottom + 4) + 'px';
    tableMenu.hidden = false;
  }

  tableMenu.addEventListener('mousedown', e => {
    e.preventDefault();
    const btn = e.target.closest('[data-tbl]');
    if (!btn || btn.hasAttribute('data-disabled')) return;
    tableMenu.hidden = true;
    const c = editor.chain().focus();
    switch (btn.dataset.tbl) {
      case 'insert':         c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
      case 'insertNoHeader': c.insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run(); break;
      case 'addColBefore': c.addColumnBefore().run(); break;
      case 'addColAfter':  c.addColumnAfter().run(); break;
      case 'addRowBefore': c.addRowBefore().run(); break;
      case 'addRowAfter':  c.addRowAfter().run(); break;
      case 'deleteCol':    c.deleteColumn().run(); break;
      case 'deleteRow':    c.deleteRow().run(); break;
      case 'deleteTable':  c.deleteTable().run(); break;
    }
    updateToolbar();
  });

  function closeTableMenuOnOutsideClick(e) {
    if (tableMenu.hidden) return;
    if (!tableMenu.contains(e.target) && !e.target.closest('[data-cmd="table"]')) {
      tableMenu.hidden = true;
    }
  }
  document.addEventListener('mousedown', closeTableMenuOnOutsideClick);
  editor.on('destroy', () => document.removeEventListener('mousedown', closeTableMenuOnOutsideClick));

  // ── Link tooltip ──────────────────────────────────────────────────────────
  const linkTooltip = document.createElement('div');
  linkTooltip.className = 'tt-link-tooltip';
  linkTooltip.hidden = true;
  document.body.appendChild(linkTooltip);
  editor.on('destroy', () => linkTooltip.remove());

  function updateLinkTooltip() {
    if (!editor.isActive('link')) { linkTooltip.hidden = true; return; }
    const href = editor.getAttributes('link').href || '';
    const { from } = editor.state.selection;
    const coords = editor.view.coordsAtPos(from);
    const display = href.length > 55 ? href.slice(0, 52) + '…' : href;
    linkTooltip.innerHTML =
      `<span class="tt-link-url" title="${href}">${display}</span>` +
      `<button class="tt-btn" data-action="open">↗ open</button>` +
      `<button class="tt-btn" data-action="edit">edit</button>` +
      `<button class="tt-btn" data-action="remove">✕</button>`;
    linkTooltip.hidden = false;
    linkTooltip.style.left = coords.left + 'px';
    linkTooltip.style.top  = (coords.bottom + 6) + 'px';
  }

  linkTooltip.addEventListener('mousedown', e => {
    e.preventDefault();
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const href = editor.getAttributes('link').href;
    if (btn.dataset.action === 'open') {
      if (openFileFn && !/^https?:\/\//.test(href)) openFileFn(href);
      else window.open(href, '_blank', 'noopener');
    } else if (btn.dataset.action === 'edit') {
      linkTooltip.hidden = true;
      openLinkForm();
    } else if (btn.dataset.action === 'remove') {
      editor.chain().focus().unsetLink().run();
    }
    updateLinkTooltip();
  });

  // ── Link insert form ──────────────────────────────────────────────────────
  const linkInput   = linkForm.querySelector('#tt-link-url');
  const linkPages   = linkForm.querySelector('#tt-link-pages');
  let cachedFiles = null;
  let savedFrom = null, savedTo = null;

  function renderPageList(files, query) {
    const q = query.toLowerCase();
    const matches = q
      ? files.filter(f => f.toLowerCase().includes(q) || labelForFile(f).toLowerCase().includes(q))
      : files;
    if (matches.length === 0) { linkPages.hidden = true; return; }
    linkPages.innerHTML = matches.map(f =>
      `<button class="tt-link-page-item" data-path="${f}">` +
        `<span class="tt-link-page-label">${labelForFile(f)}</span>` +
        `<span class="tt-link-page-path">${f}</span>` +
      `</button>`
    ).join('');
    linkPages.hidden = false;
  }

  function openLinkForm() {
    ({ from: savedFrom, to: savedTo } = editor.state.selection);
    const prev = editor.getAttributes('link').href ?? '';
    linkInput.value = prev;
    linkPages.hidden = true;
    linkForm.hidden = false;
    linkInput.focus();
    linkInput.select();

    if (!filesUrl) return;
    const populate = files => renderPageList(files, prev);
    if (cachedFiles) { populate(cachedFiles); return; }
    fetch(filesUrl).then(r => r.json()).then(files => {
      cachedFiles = files.filter(f => !f.endsWith('/'));
      populate(cachedFiles);
    });
  }

  function commitLink() {
    const url = linkInput.value.trim();
    const from = savedFrom, to = savedTo;
    savedFrom = savedTo = null;
    linkForm.hidden = true;
    if (url === '') { editor.chain().focus().unsetLink().run(); return; }
    editor.chain().focus().setTextSelection({ from, to }).setLink({ href: url }).run();
  }

  linkInput.addEventListener('input', () => {
    if (!cachedFiles) return;
    renderPageList(cachedFiles, linkInput.value);
  });
  linkInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commitLink(); }
    if (e.key === 'Escape') { linkForm.hidden = true; editor.commands.focus(); }
  });
  linkPages.addEventListener('click', e => {
    const item = e.target.closest('[data-path]');
    if (!item) return;
    linkInput.value = item.dataset.path;
    commitLink();
  });
  linkForm.querySelector('#tt-link-ok').addEventListener('click', commitLink);
  linkForm.querySelector('#tt-link-remove').addEventListener('click', () => {
    linkForm.hidden = true;
    editor.chain().focus().unsetLink().run();
  });
  linkForm.querySelector('#tt-link-cancel').addEventListener('click', () => {
    linkForm.hidden = true;
    editor.commands.focus();
  });

  function handleLink() { openLinkForm(); }

  // ── Source mode ───────────────────────────────────────────────────────────
  // inSourceMode is declared up in the save/dirty block — currentMarkdown() needs it.
  const sourceBtn = toolbar.querySelector('[data-cmd="source"]');

  function toggleSource() {
    inSourceMode = !inSourceMode;
    if (inSourceMode) {
      sourceEl.value = frontmatter + unresolveImages(getMarkdown(), baseUrl);
      contentEl.hidden = true; sourceEl.hidden = false;
      sourceBtn.classList.add('active');
      sourceEl.focus();
    } else {
      ({ fm: frontmatter, body: bodyMarkdown } = splitFrontmatter(sourceEl.value));
      editor.commands.setContent(resolveImages(bodyMarkdown, baseUrl));
      sourceEl.hidden = true; contentEl.hidden = false;
      sourceBtn.classList.remove('active');
      editor.commands.focus();
    }
  }

  // ── Table of Contents ─────────────────────────────────────────────────────
  function escH(str) {
    const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
  }

  function updateToc() {
    const els = [...contentEl.querySelectorAll('h2,h3,h4,h5,h6')];
    if (els.length === 0) { tocEl.style.display = 'none'; return; }
    tocEl.style.display = 'flex';
    tocEl.innerHTML = els.map((h, i) => {
      const lv = parseInt(h.tagName[1]);
      return `<a class="toc-item toc-level-${lv}" style="padding-left:${(lv-2)*12+10}px" data-i="${i}">${escH(h.textContent)}</a>`;
    }).join('');
    tocEl.querySelectorAll('.toc-item').forEach((a, i) => {
      a.addEventListener('click', () => {
        // Direct scrollIntoView works because tiptap-content is our own scroll container
        const scrollEl = contentEl;
        const target   = els[i];
        const top = target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
        scrollEl.scrollTo({ top: top - 16, behavior: 'smooth' });
      });
    });
  }

  updateToc();
}

// ── Tree builders (private) ───────────────────────────────────────────────────
function buildTree(files) {
  const tree = { dirs: {}, files: [] };
  for (const f of files) {
    if (f.endsWith('/')) {
      const parts = f.slice(0, -1).split('/');
      let node = tree;
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        const rp  = parts.slice(0, i + 1).join('/');
        if (!node.dirs[seg]) node.dirs[seg] = { dirs: {}, files: [], relPath: rp };
        node = node.dirs[seg];
      }
    } else {
      const parts = f.split('/');
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        const rp  = parts.slice(0, i + 1).join('/');
        if (!node.dirs[seg]) node.dirs[seg] = { dirs: {}, files: [], relPath: rp };
        node = node.dirs[seg];
      }
      node.files.push(f);
    }
  }
  return tree;
}

function fileRowHtml(f) {
  return `<div class="file-row" draggable="true" data-file="${f}">` +
    `<button class="checklist-nav-btn file-nav-btn" data-file="${f}">${FILE_ICON}<span class="file-label">${labelForFile(f)}</span></button>` +
    `<button class="file-row-rename" data-file="${f}" title="Rename">✎</button>` +
    `<button class="file-row-delete" data-file="${f}" title="Delete">&#x2715;</button>` +
    `</div>`;
}

function folderHtml(name, node, collapsedFolders) {
  const fp        = node.relPath;
  const collapsed = collapsedFolders.has(fp);
  let h = `<div class="folder-item">`;
  h += `<div class="folder-header" data-folder="${fp}">`;
  h += `<span class="folder-chevron${collapsed ? ' collapsed' : ''}">&#x25BE;</span>`;
  h += FOLDER_ICON;
  h += `<span class="folder-name">${humanize(name)}</span>`;
  h += `<div class="folder-actions">`;
  h += `<button class="folder-action-btn" data-folder="${fp}" data-action="add" title="New file in folder">+</button>`;
  h += `<button class="folder-action-btn" data-folder="${fp}" data-action="delete" title="Delete folder">&#x2715;</button>`;
  h += `</div></div>`;
  h += `<div class="folder-children${collapsed ? ' collapsed' : ''}" data-folder="${fp}">`;
  for (const [n, child] of Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b)))
    h += folderHtml(n, child, collapsedFolders);
  for (const f of node.files) h += fileRowHtml(f);
  h += `<div class="inline-new-row" data-new-in="${fp}" hidden>`;
  h += `<input class="proj-new-file-input inline-new-input" data-folder="${fp}" placeholder="filename" autocomplete="off" spellcheck="false" />`;
  h += `</div></div></div>`;
  return h;
}

function renderTreeHtml(tree, collapsedFolders) {
  let h = '';
  for (const [name, child] of Object.entries(tree.dirs).sort(([a], [b]) => a.localeCompare(b)))
    h += folderHtml(name, child, collapsedFolders);
  for (const f of tree.files) h += fileRowHtml(f);
  return h;
}

// ── Main initializer ──────────────────────────────────────────────────────────
export function initEditor({
  root,
  projectPath   = '',
  initialFile   = null,
  // DOM refs
  sidebarEl,
  navEl,
  tabsEl,
  contentEl,
  emptyEl,
  tabsEmptyEl,
  fileAddBtn,
  newFileRow,
  newFileInput,
  folderAddBtn,
  newFolderRow,
  newFolderInput,
  // Optional resize refs
  vResizeHandle = null,
  hResizeHandle = null,
  hResizePanel  = null,
  // Behavior
  onOpenPane,
  autoOpenReadme = false,
}) {
  const filesUrl = projectPath
    ? `/api/project-files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(projectPath)}`
    : `/api/project-files?root=${encodeURIComponent(root)}`;

  const openTabs       = [];
  const collapsedKey   = `project-collapsed:${root}:${projectPath}`;
  const collapsedFolders = new Set(JSON.parse(localStorage.getItem(collapsedKey) || '[]'));

  function saveCollapsed() {
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsedFolders]));
  }

  // ── Tab management ──────────────────────────────────────────────────────────
  function activateTab(relPath) {
    openTabs.forEach(t => {
      const on = t.relPath === relPath;
      t.tabEl.classList.toggle('active', on);
      t.paneEl.classList.toggle('active', on);
    });
    emptyEl.hidden = true;
    tabsEmptyEl.hidden = true;
    navEl.querySelectorAll('.file-nav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.file === relPath)
    );
  }

  function closeTab(relPath) {
    const idx = openTabs.findIndex(t => t.relPath === relPath);
    if (idx === -1) return;
    const { tabEl, paneEl } = openTabs[idx];
    const wasActive = tabEl.classList.contains('active');
    tabEl.remove();
    paneEl.remove();
    openTabs.splice(idx, 1);

    if (openTabs.length === 0) {
      emptyEl.hidden = false;
      tabsEmptyEl.hidden = false;
      navEl.querySelectorAll('.file-nav-btn').forEach(b => b.classList.remove('active'));
    } else if (wasActive) {
      activateTab(openTabs[Math.min(idx, openTabs.length - 1)].relPath);
    }
  }

  function openFile(relPath, permanent = false) {
    const existing = openTabs.find(t => t.relPath === relPath);
    if (existing) { activateTab(relPath); return; }

    const tab = document.createElement('button');
    tab.className = 'editor-tab' + (permanent ? ' editor-tab-permanent' : '');
    tab.dataset.file = relPath;
    tab.innerHTML = permanent
      ? `<span class="editor-tab-label">${labelForFile(relPath)}</span>`
      : `<span class="editor-tab-label">${labelForFile(relPath)}</span>` +
        `<span class="editor-tab-close" title="Close">&#x2715;</span>`;

    if (!permanent) {
      tab.querySelector('.editor-tab-close').addEventListener('click', e => {
        e.stopPropagation();
        closeTab(relPath);
      });
    }
    tab.addEventListener('click', () => activateTab(relPath));

    const pane = document.createElement('div');
    pane.className = 'editor-pane';
    pane.innerHTML = '<p class="pane-loading">Loading…</p>';

    tabsEl.appendChild(tab);
    contentEl.appendChild(pane);
    openTabs.push({ relPath, tabEl: tab, paneEl: pane });
    activateTab(relPath);

    const mdPath = projectPath ? `${projectPath}/${relPath}` : relPath;
    fetch(`/api/md?root=${encodeURIComponent(root)}&path=${encodeURIComponent(mdPath)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          pane.innerHTML = `<p style="color:var(--muted)">${data.error}</p>`;
          return;
        }
        onOpenPane(relPath, data, tab, pane, permanent);
      });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  function deleteFile(relPath) {
    if (!confirm(`Delete "${labelForFile(relPath)}"?\n\nThis cannot be undone.`)) return;
    const fullPath = projectPath ? `${projectPath}/${relPath}` : relPath;
    fetch('/api/project-file', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      closeTab(relPath);
      reloadNav();
    });
  }

  function deleteFolder(folderRelPath) {
    const label = humanize(folderRelPath.split('/').pop());
    if (!confirm(`Delete folder "${label}" and all its contents?\n\nThis cannot be undone.`)) return;
    const fullPath = projectPath ? `${projectPath}/${folderRelPath}` : folderRelPath;
    fetch('/api/project-folder', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      [...openTabs].filter(t => t.relPath.startsWith(folderRelPath + '/')).forEach(t => closeTab(t.relPath));
      reloadNav();
    });
  }

  function startInlineRename(relPath, renameBtn) {
    const row      = renameBtn.closest('.file-row');
    const navBtn   = row.querySelector('.file-nav-btn');
    const labelEl  = navBtn.querySelector('.file-label');
    const baseName = relPath.split('/').pop().replace(/\.md$/, '');

    const input = document.createElement('input');
    input.className = 'file-rename-input';
    input.value = baseName;
    labelEl.replaceWith(input);
    navBtn.style.pointerEvents = 'none';
    renameBtn.hidden = true;
    input.focus();
    input.select();

    let done = false;

    function cancel() {
      if (done) return; done = true;
      input.replaceWith(labelEl);
      navBtn.style.pointerEvents = '';
      renameBtn.hidden = false;
    }

    function commit() {
      if (done) return; done = true;
      const newBase = input.value.trim();
      if (!newBase || newBase === baseName) { done = false; cancel(); return; }
      const dir        = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '';
      const newRelPath = dir + newBase + '.md';
      const fromFull   = projectPath ? `${projectPath}/${relPath}` : relPath;
      const toFull     = projectPath ? `${projectPath}/${newRelPath}` : newRelPath;
      const openTab    = openTabs.find(t => t.relPath === relPath);
      if (openTab?.tabEl.classList.contains('tab-dirty')) {
        if (!confirm('This file has unsaved changes. Rename anyway? Changes will be lost.')) {
          done = false; cancel(); return;
        }
      }
      fetch('/api/project-file/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root, from: fromFull, to: toFull }),
      }).then(r => r.json()).then(d => {
        if (d.error) { alert(d.error); done = false; cancel(); return; }
        const wasActive = openTab?.tabEl.classList.contains('active');
        if (openTab) closeTab(relPath);
        reloadNav().then(() => { if (wasActive || openTab) openFile(newRelPath); });
      });
    }

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', cancel);
  }

  function moveFile(relPath, targetFolder) {
    const filename   = relPath.split('/').pop();
    const newRelPath = targetFolder ? `${targetFolder}/${filename}` : filename;
    if (relPath === newRelPath) return;
    const fromFull = projectPath ? `${projectPath}/${relPath}` : relPath;
    const toFull   = projectPath ? `${projectPath}/${newRelPath}` : newRelPath;
    const wasOpen  = !!openTabs.find(t => t.relPath === relPath);
    fetch('/api/project-file/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, from: fromFull, to: toFull }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      closeTab(relPath);
      reloadNav().then(() => { if (wasOpen) openFile(newRelPath); });
    });
  }

  // ── Nav events ──────────────────────────────────────────────────────────────
  function bindNavEvents(nav) {
    nav.querySelectorAll('.file-nav-btn').forEach(btn =>
      btn.addEventListener('click', () => openFile(btn.dataset.file))
    );
    nav.querySelectorAll('.file-row-rename').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); startInlineRename(btn.dataset.file, btn); })
    );
    nav.querySelectorAll('.file-row-delete').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); deleteFile(btn.dataset.file); })
    );

    nav.querySelectorAll('.folder-header').forEach(header => {
      header.addEventListener('click', e => {
        if (e.target.closest('.folder-actions')) return;
        const fp = header.dataset.folder;
        if (collapsedFolders.has(fp)) collapsedFolders.delete(fp); else collapsedFolders.add(fp);
        saveCollapsed();
        header.querySelector('.folder-chevron').classList.toggle('collapsed', collapsedFolders.has(fp));
        nav.querySelector(`.folder-children[data-folder="${CSS.escape(fp)}"]`).classList.toggle('collapsed', collapsedFolders.has(fp));
      });
    });

    nav.querySelectorAll('.folder-action-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const fp = btn.dataset.folder;
        if (btn.dataset.action === 'delete') { deleteFolder(fp); return; }
        if (collapsedFolders.has(fp)) {
          collapsedFolders.delete(fp); saveCollapsed();
          nav.querySelector(`.folder-header[data-folder="${CSS.escape(fp)}"] .folder-chevron`).classList.remove('collapsed');
          nav.querySelector(`.folder-children[data-folder="${CSS.escape(fp)}"]`).classList.remove('collapsed');
        }
        const row = nav.querySelector(`.inline-new-row[data-new-in="${CSS.escape(fp)}"]`);
        if (row) { row.hidden = false; row.querySelector('input').value = ''; row.querySelector('input').focus(); }
      });
    });

    nav.querySelectorAll('.inline-new-input').forEach(input => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { input.closest('.inline-new-row').hidden = true; return; }
        if (e.key !== 'Enter') return;
        let name = input.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
        if (!name) return;
        if (!name.endsWith('.md')) name += '.md';
        const fp = input.dataset.folder;
        input.closest('.inline-new-row').hidden = true;
        const relPath  = `${fp}/${name}`;
        const fullPath = projectPath ? `${projectPath}/${relPath}` : relPath;
        fetch('/api/project-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, path: fullPath }),
        }).then(r => r.json()).then(data => {
          if (data.error) { alert(data.error); return; }
          reloadNav().then(() => openFile(relPath));
        });
      });
      input.addEventListener('blur', () => { input.closest('.inline-new-row').hidden = true; });
    });

    // Drag and drop
    nav.querySelectorAll('.file-row').forEach(row => {
      row.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', row.dataset.file);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('drag-source');
        e.stopPropagation();
      });
      row.addEventListener('dragend', () => { row.classList.remove('drag-source'); clearDropHighlights(); });
    });

    nav.querySelectorAll('.folder-header').forEach(header => {
      header.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); header.classList.add('drop-over'); nav.classList.remove('drop-root'); });
      header.addEventListener('dragleave', e => { if (!header.contains(e.relatedTarget)) header.classList.remove('drop-over'); });
      header.addEventListener('drop',      e => { e.preventDefault(); e.stopPropagation(); clearDropHighlights(); const src = e.dataTransfer.getData('text/plain'); if (src) moveFile(src, header.dataset.folder); });
    });

    nav.addEventListener('dragover',  e => { e.preventDefault(); nav.classList.add('drop-root'); });
    nav.addEventListener('dragleave', e => { if (!nav.contains(e.relatedTarget)) nav.classList.remove('drop-root'); });
    nav.addEventListener('drop',      e => { e.preventDefault(); clearDropHighlights(); const src = e.dataTransfer.getData('text/plain'); if (src) moveFile(src, ''); });

    function clearDropHighlights() {
      nav.classList.remove('drop-root');
      nav.querySelectorAll('.drop-over').forEach(el => el.classList.remove('drop-over'));
    }
  }

  function renderNav(files) {
    const navFiles = files.filter(f => f.toLowerCase() !== 'readme.md').sort((a, b) => a.localeCompare(b));
    navEl.innerHTML = renderTreeHtml(buildTree(navFiles), collapsedFolders);
    bindNavEvents(navEl);
  }

  function reloadNav() {
    return fetch(filesUrl).then(r => r.json()).then(renderNav);
  }

  // ── New file / folder inputs ────────────────────────────────────────────────
  fileAddBtn.addEventListener('click', () => {
    newFileRow.hidden = false;
    newFileInput.value = '';
    newFileInput.focus();
  });

  newFileInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { newFileRow.hidden = true; return; }
    if (e.key !== 'Enter') return;
    let name = newFileInput.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    if (!name) return;
    if (!name.endsWith('.md')) name += '.md';
    newFileRow.hidden = true;
    const fullPath = projectPath ? `${projectPath}/${name}` : name;
    fetch('/api/project-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      reloadNav().then(() => openFile(name));
    });
  });
  newFileInput.addEventListener('blur', () => { newFileRow.hidden = true; });

  folderAddBtn.addEventListener('click', () => {
    newFolderRow.hidden = false;
    newFolderInput.value = '';
    newFolderInput.focus();
  });

  newFolderInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { newFolderRow.hidden = true; return; }
    if (e.key !== 'Enter') return;
    let name = newFolderInput.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    if (!name) return;
    newFolderRow.hidden = true;
    const fullPath = projectPath ? `${projectPath}/${name}` : name;
    fetch('/api/project-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path: fullPath }),
    }).then(r => r.json()).then(data => {
      if (data.error) { alert(data.error); return; }
      reloadNav();
    });
  });
  newFolderInput.addEventListener('blur', () => { newFolderRow.hidden = true; });

  // ── Vertical resize: sidebar ↔ editor ──────────────────────────────────────
  if (vResizeHandle && sidebarEl) {
    const savedW = localStorage.getItem('project:sidebar-width');
    if (savedW) sidebarEl.style.width = savedW;

    let vDrag = false, vX0 = 0, vW0 = 0;
    vResizeHandle.addEventListener('mousedown', e => {
      vDrag = true; vX0 = e.clientX; vW0 = sidebarEl.getBoundingClientRect().width;
      vResizeHandle.classList.add('dragging'); e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!vDrag) return;
      sidebarEl.style.width = `${Math.max(160, Math.min(vW0 + (e.clientX - vX0), 480))}px`;
    });
    document.addEventListener('mouseup', () => {
      if (vDrag) {
        vDrag = false; vResizeHandle.classList.remove('dragging');
        localStorage.setItem('project:sidebar-width', sidebarEl.style.width);
      }
    });
  }

  // ── Horizontal resize: files panel ↕ tasks panel ───────────────────────────
  if (hResizeHandle && hResizePanel && sidebarEl) {
    const savedH = localStorage.getItem('project:files-panel-height');
    if (savedH) hResizePanel.style.flex = `0 0 ${savedH}`;

    let hDrag = false, hY0 = 0, hH0 = 0;
    hResizeHandle.addEventListener('mousedown', e => {
      hDrag = true; hY0 = e.clientY; hH0 = hResizePanel.getBoundingClientRect().height;
      hResizeHandle.classList.add('dragging'); e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!hDrag) return;
      const sH   = sidebarEl.getBoundingClientRect().height;
      const hH   = hResizeHandle.getBoundingClientRect().height;
      const minH = 60;
      hResizePanel.style.flex = `0 0 ${Math.max(minH, Math.min(hH0 + (e.clientY - hY0), sH - hH - minH))}px`;
    });
    document.addEventListener('mouseup', () => {
      if (hDrag) {
        hDrag = false; hResizeHandle.classList.remove('dragging');
        localStorage.setItem('project:files-panel-height', hResizePanel.getBoundingClientRect().height + 'px');
      }
    });
  }

  // ── Initial load ────────────────────────────────────────────────────────────
  fetch(filesUrl)
    .then(r => r.json())
    .then(files => {
      const readmeFile = files.find(f => f.toLowerCase() === 'readme.md');
      if (readmeFile && autoOpenReadme) openFile(readmeFile, true);
      renderNav(files);
      if (initialFile && initialFile.toLowerCase() !== 'readme.md') openFile(initialFile);
    });

  function openContent(key, label, markdown, saveFn) {
    const existing = openTabs.find(t => t.relPath === key);
    if (existing) { activateTab(key); return; }

    const tab = document.createElement('button');
    tab.className = 'editor-tab';
    tab.dataset.file = key;
    tab.innerHTML =
      `<span class="editor-tab-label">${label}</span>` +
      `<span class="editor-tab-close" title="Close">&#x2715;</span>`;
    tab.querySelector('.editor-tab-close').addEventListener('click', e => {
      e.stopPropagation();
      closeTab(key);
    });
    tab.addEventListener('click', () => activateTab(key));

    const pane = document.createElement('div');
    pane.className = 'editor-pane';

    tabsEl.appendChild(tab);
    contentEl.appendChild(pane);
    openTabs.push({ relPath: key, tabEl: tab, paneEl: pane });
    activateTab(key);

    setupTuiPane(pane, tab, { markdown, root, savePath: key, saveFn, imageBaseUrl: '', openFileFn: openFile, filesUrl });
  }

  // Opens a tab/pane not backed by a markdown file — the caller renders the pane's
  // content itself (e.g. a Kanban board). Participates in the same tab bookkeeping
  // (activateTab/closeTab) as openFile/openContent.
  function openCustomPane(key, label, renderFn, { permanent = false } = {}) {
    const existing = openTabs.find(t => t.relPath === key);
    if (existing) { activateTab(key); return; }

    const tab = document.createElement('button');
    tab.className = 'editor-tab' + (permanent ? ' editor-tab-permanent' : '');
    tab.dataset.file = key;
    tab.innerHTML = permanent
      ? `<span class="editor-tab-label">${label}</span>`
      : `<span class="editor-tab-label">${label}</span>` +
        `<span class="editor-tab-close" title="Close">&#x2715;</span>`;

    if (!permanent) {
      tab.querySelector('.editor-tab-close').addEventListener('click', e => {
        e.stopPropagation();
        closeTab(key);
      });
    }
    tab.addEventListener('click', () => activateTab(key));

    const pane = document.createElement('div');
    pane.className = 'editor-pane';

    tabsEl.appendChild(tab);
    contentEl.appendChild(pane);
    openTabs.push({ relPath: key, tabEl: tab, paneEl: pane });

    renderFn(pane);
  }

  function handleBeforeUnload(e) {
    if (tabsEl.querySelector('.tab-dirty')) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  window.addEventListener('beforeunload', handleBeforeUnload);

  return { openFile, reloadNav, activateTab, closeTab, openContent, openCustomPane };
}
