// Shared drag-to-resize for any .resize-handle element.
// The handle's previousElementSibling is the left column being resized.
// The right column has flex:1 and fills the remaining space automatically.

document.querySelectorAll('.resize-handle').forEach(handle => {
  const leftCol = handle.previousElementSibling;
  if (!leftCol) return;

  let dragging = false;
  let startX   = 0;
  let startW   = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = leftCol.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const layout = leftCol.parentElement;
    const pad    = parseFloat(getComputedStyle(layout).paddingLeft) * 2;
    const total  = layout.getBoundingClientRect().width - pad - handle.offsetWidth;
    const newW   = Math.max(220, Math.min(total - 220, startW + (e.clientX - startX)));
    leftCol.style.flex = `0 0 ${newW}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
});
