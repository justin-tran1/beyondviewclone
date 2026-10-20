// Site-wide behavior. Loaded as a classic deferred script so pages work without a build step.
(function () {
  'use strict';

  var doc = document.documentElement;
  doc.classList.add('js');

  // ---- Header: sticky shadow, mobile menu, dropdowns ----------------------
  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var toggle = document.querySelector('[data-nav-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  var dropdownButtons = document.querySelectorAll('[data-dropdown]');
  function closeDropdowns(except) {
    dropdownButtons.forEach(function (btn) {
      if (btn === except) return;
      btn.setAttribute('aria-expanded', 'false');
      btn.parentElement.removeAttribute('data-open');
    });
  }
  dropdownButtons.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = btn.getAttribute('aria-expanded') !== 'true';
      closeDropdowns(btn);
      btn.setAttribute('aria-expanded', String(open));
      if (open) btn.parentElement.setAttribute('data-open', 'true');
      else btn.parentElement.removeAttribute('data-open');
    });
  });
  document.addEventListener('click', function () { closeDropdowns(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeDropdowns();
    if (document.body.classList.contains('nav-open') && toggle) {
      document.body.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });
  document.querySelectorAll('.primary-nav a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function () {
      document.body.classList.remove('nav-open');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  });

  // ---- Before / after sliders ---------------------------------------------
  document.querySelectorAll('[data-compare]').forEach(function (el) {
    var range = el.querySelector('.compare__range');
    var set = function (v) { el.style.setProperty('--pos', v + '%'); };
    set(range.value);
    range.addEventListener('input', function () { set(range.value); });

    // Optional chips that swap the "before" image (e.g. As-is vs Whitebox).
    var group = document.querySelector('[data-compare-chips="' + el.id + '"]');
    if (!group) return;
    var beforeImg = el.querySelector('.compare__before img');
    var beforeLabel = el.querySelector('.compare__label--before');
    group.querySelectorAll('button').forEach(function (chip) {
      chip.addEventListener('click', function () {
        group.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === chip)); });
        beforeImg.src = chip.getAttribute('data-src');
        beforeImg.alt = chip.getAttribute('data-alt') || '';
        if (beforeLabel) beforeLabel.textContent = chip.getAttribute('data-label');
      });
    });
  });

  // ---- Carousel -----------------------------------------------------------
  document.querySelectorAll('[data-carousel]').forEach(function (root) {
    var track = root.querySelector('.carousel__track');
    var slides = Array.prototype.slice.call(track.children);
    var prev = root.querySelector('.carousel__nav--prev');
    var next = root.querySelector('.carousel__nav--next');
    var dots = root.querySelector('.carousel__dots');

    var step = function () { return slides[0].getBoundingClientRect().width + parseFloat(getComputedStyle(track).columnGap || 0); };
    var buttons = slides.map(function (_, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Go to image ' + (i + 1));
      b.addEventListener('click', function () { track.scrollTo({ left: i * step() }); });
      dots.appendChild(b);
      return b;
    });
    var update = function () {
      var i = Math.round(track.scrollLeft / step());
      buttons.forEach(function (b, j) { b.setAttribute('aria-current', String(i === j)); });
      prev.disabled = track.scrollLeft < 4;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    };
    prev.addEventListener('click', function () { track.scrollBy({ left: -step() }); });
    next.addEventListener('click', function () { track.scrollBy({ left: step() }); });
    track.addEventListener('scroll', function () { window.requestAnimationFrame(update); }, { passive: true });
    window.addEventListener('resize', update);
    update();
  });

  // ---- Reveal on scroll ---------------------------------------------------
  var reveals = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  }

  // ---- Lead form ----------------------------------------------------------
  // No backend is wired up yet: the form validates, then shows a confirmation.
  // Point the form's action at your CRM or form service to collect submissions.
  document.querySelectorAll('[data-lead-form]').forEach(function (wrap) {
    var form = wrap.querySelector('form');
    var fields = form.querySelectorAll('[required]');
    var validate = function (input) {
      var ok = input.checkValidity();
      input.closest('.field').classList.toggle('is-invalid', !ok);
      input.setAttribute('aria-invalid', String(!ok));
      return ok;
    };
    fields.forEach(function (input) {
      input.addEventListener('blur', function () { validate(input); });
      input.addEventListener('input', function () {
        if (input.closest('.field').classList.contains('is-invalid')) validate(input);
      });
    });
    form.addEventListener('submit', function (e) {
      var firstBad = null;
      fields.forEach(function (input) { if (!validate(input) && !firstBad) firstBad = input; });
      if (firstBad) {
        e.preventDefault();
        firstBad.focus();
        return;
      }
      if (form.getAttribute('action')) return;
      e.preventDefault();
      wrap.classList.add('is-sent');
      var success = wrap.querySelector('.form-success');
      success.setAttribute('tabindex', '-1');
      success.focus();
      form.reset();
    });
  });

  // ---- Footer year --------------------------------------------------------
  document.querySelectorAll('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
