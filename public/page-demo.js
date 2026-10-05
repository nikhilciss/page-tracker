let count = 0;
document.querySelector('#change-page').addEventListener('click', () => {
  document.querySelector('#page-result').textContent = 'Page changed ' + ++count + ' time(s).';
});
document.querySelector('#native-reload').addEventListener('click', () => location.reload());
