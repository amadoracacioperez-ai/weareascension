/* The request form. It checks the fields here, sends the request to Web3Forms (which delivers it to the agency's
   Gmail) and answers in place: a "Request sent" panel, or an error with WhatsApp as the way out.
   Without this script the form still posts to Web3Forms with the browser's own checks, and Web3Forms shows its
   thank-you page. The only request this page makes to another site is this one, when someone presses Send. */
(function () {
  'use strict';

  var form = document.getElementById('request');
  if (!form || !window.fetch || !window.FormData) return;
  form.noValidate = true; // the messages below replace the browser's bubbles

  var status = form.querySelector('.request__status');
  var send = form.querySelector('.request__send');
  var done = document.getElementById('request-done');
  var chips = form.querySelector('.chips');
  var sendLabel = send.textContent;
  var touched = false; // after the first Send, the fields re-check as you type, so a message goes as soon as it is right

  var checks = [
    { name: 'name', error: 'e-name', ok: function (el) { return el.value.trim() !== ''; } },
    { name: 'email', error: 'e-email', ok: function (el) { return el.value.trim() !== '' && el.validity.valid; } },
    { name: 'country', error: 'e-country', ok: function (el) { return el.value !== ''; } },
    { name: 'website', error: 'e-website', ok: function (el) { return el.value.trim() === '' || el.validity.valid; } }
  ];

  function servicesChosen() {
    return form.querySelectorAll('input[name="services"]:checked').length > 0;
  }

  // Marks every field and returns the first one that is wrong, or null.
  function validate() {
    var first = null;
    checks.forEach(function (c) {
      var el = form.elements[c.name];
      var bad = !c.ok(el);
      if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
      document.getElementById(c.error).hidden = !bad;
      if (bad && !first) first = el;
    });
    var noService = !servicesChosen();
    chips.classList.toggle('is-invalid', noService);
    document.getElementById('e-services').hidden = !noService;
    if (noService && !first) first = form.querySelector('input[name="services"]');
    return first;
  }

  function say(text, tone, withWhatsApp) {
    status.textContent = text;
    if (tone) status.dataset.tone = tone; else delete status.dataset.tone;
    var wa = document.querySelector('a[data-wa]');
    if (withWhatsApp && wa) {
      status.appendChild(document.createTextNode(' '));
      var link = document.createElement('a');
      link.href = wa.href;
      link.textContent = 'Message us on WhatsApp';
      status.appendChild(link);
      status.appendChild(document.createTextNode('.'));
    }
  }

  function recheck() {
    if (!touched) return;
    if (!validate()) say('', null);
  }
  form.addEventListener('input', recheck);
  form.addEventListener('change', recheck);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    touched = true;
    var first = validate();
    if (first) {
      say('Please check the highlighted fields.', 'error');
      first.focus();
      return;
    }
    if (form.elements.botcheck && form.elements.botcheck.checked) return; // only a bot ticks the hidden box

    var data = {};
    new FormData(form).forEach(function (value, key) {
      if (key === 'botcheck') return;
      if (key === 'services') data.services = data.services ? data.services + ', ' + value : value;
      else data[key] = typeof value === 'string' ? value.trim() : value;
    });

    send.disabled = true;
    send.textContent = 'Sending…';
    say('', null);

    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (response) {
        return response.json().catch(function () { return null; });
      })
      .then(function (result) {
        if (!result || result.success !== true) throw new Error('Not sent');
        form.reset();
        form.hidden = true;
        form.parentNode.querySelector('.form-card__or').hidden = true;
        done.hidden = false;
        done.focus();
      })
      .catch(function () {
        say('Something went wrong and your request was not sent. Please try again, or', 'error', true);
      })
      .then(function () {
        send.disabled = false;
        send.textContent = sendLabel;
      });
  });
}());
