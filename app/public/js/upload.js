// Upload with progress bar (large audio files)
const STRINGS = JSON.parse(document.getElementById('i18n')?.textContent || '{}');
const t = (key) => STRINGS[`upload.${key}`] ?? key;
for (const form of document.querySelectorAll('form[data-upload]')) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const bar = form.querySelector('progress');
    const button = form.querySelector('button');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (ev) => { if (ev.lengthComputable) bar.value = (ev.loaded / ev.total) * 100; });
    xhr.addEventListener('load', () => {
      if (xhr.status < 300 && xhr.response?.redirect) location.href = xhr.response.redirect;
      else { alert(t('failed') + ' ' + (xhr.response?.error || xhr.status)); button.disabled = false; bar.hidden = true; }
    });
    xhr.addEventListener('error', () => { alert(t('connectionFailed')); button.disabled = false; bar.hidden = true; });
    bar.hidden = false; button.disabled = true; button.textContent = t('uploading');
    xhr.send(new FormData(form));
  });
}
