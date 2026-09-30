document.querySelectorAll('.nav a').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    document.querySelector(link.getAttribute('href')).scrollIntoView({ behavior: 'smooth' });
  });
});
