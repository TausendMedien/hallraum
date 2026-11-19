// Ask before submitting forms marked with data-confirm (text comes translated from the server)
for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', (e) => { if (!confirm(form.dataset.confirm)) e.preventDefault(); });
}
