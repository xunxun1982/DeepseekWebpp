const id = new URLSearchParams(location.search).get('id');
let pending = null;

chrome.runtime.sendMessage({ type: 'pending.get', id }, (request) => {
  pending = request;
  document.getElementById('request').textContent = JSON.stringify(request && request.call, null, 2);
});

document.getElementById('allow-once').addEventListener('click', () => {
  decide('allow_once');
});
document.getElementById('allow-scope').addEventListener('click', () => {
  const selected = document.getElementById('scope').value;
  decide('allow_scope', selected === 'any' ? 'any' : 'exact');
});
document.getElementById('deny').addEventListener('click', () => {
  decide('deny');
});

function decide(decision, scopeMode) {
  chrome.runtime.sendMessage({ type: 'confirm.result', id, decision, scopeMode }, () => {
    window.close();
  });
}
