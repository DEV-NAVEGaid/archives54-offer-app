(function () {
  if (window.A54QuickBid) return;

  var OFFER_URL = '/apps/archives54-offer-app/offers';
  var COUNTER_URL = '/apps/archives54-offer-app/offers/counter-accept';
  var MODAL_CONTENT_ID = 'quick-add-modal-content';
  var counterTimer = null;

  function waitForModalContent() {
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      function check() {
        var content = document.getElementById(MODAL_CONTENT_ID);
        if (content && content.children.length) {
          resolve(content);
          return;
        }
        attempts += 1;
        if (attempts > 30) {
          reject(new Error('Quick-add modal content not found'));
          return;
        }
        requestAnimationFrame(check);
      }
      check();
    });
  }

  function readVariantId(content, fallback) {
    var input = content.querySelector('input[name="id"]');
    var select = content.querySelector('select[name="id"]');
    return (input && input.value) || (select && select.value) || fallback || '';
  }

  function setPanelMessage(panel, message, tone) {
    var messageEl = panel.querySelector('[data-a54-message]');
    if (!messageEl) return;
    messageEl.textContent = message || '';
    messageEl.dataset.tone = tone || 'normal';
  }

  function panelShell() {
    var panel = document.createElement('section');
    panel.className = 'a54-quick-bid-panel';
    panel.dataset.a54QuickBidPanel = 'true';
    panel.innerHTML = [
      '<button type="button" class="a54-quick-bid-modal-trigger" data-a54-open-offer>ANGEBOT MACHEN</button>',
      '<div class="a54-quick-bid-message" data-a54-message role="status"></div>',
      '<div class="a54-quick-bid-result" data-a54-result></div>'
    ].join('');
    return panel;
  }

  function showForm(panel) {
    panel.innerHTML = [
      '<div class="a54-quick-bid-heading">Preis verhandeln</div>',
      '<form data-a54-offer-form>',
      '<label class="a54-quick-bid-label">Ihr Angebot</label>',
      '<div class="a54-quick-bid-row">',
      '<input data-a54-offer-input type="number" min="0.01" step="0.01" inputmode="decimal" required aria-label="Ihr Angebot">',
      '<button type="submit" class="a54-quick-bid-submit">ANGEBOT SENDEN</button>',
      '</div>',
      '</form>',
      '<div class="a54-quick-bid-message" data-a54-message role="status"></div>',
      '<div class="a54-quick-bid-result" data-a54-result></div>'
    ].join('');
    panel.querySelector('[data-a54-offer-form]').addEventListener('submit', function (event) {
      event.preventDefault();
      submitOffer(panel, panel.querySelector('[data-a54-offer-input]'));
    });
  }

  function showAccepted(panel, data) {
    var result = panel.querySelector('[data-a54-result]');
    var code = data.discountCode
      ? '<div class="a54-quick-bid-code">' + data.discountCode + '</div>'
      : '<div class="a54-quick-bid-no-code">Kein Rabattcode erforderlich.</div>';
    panel.querySelector('[data-a54-offer-form]')?.remove();
    setPanelMessage(panel, data.message || 'Ihr Angebot wurde akzeptiert!', 'success');
    if (result) result.innerHTML = code + '<small>Gültig für 30 Minuten.</small>';
  }

  function stopCounterTimer() {
    if (counterTimer) window.clearInterval(counterTimer);
    counterTimer = null;
  }

  function showCounter(panel, data) {
    stopCounterTimer();
    var price = Number(data.counterPrice);
    panel.dataset.counterPrice = price.toFixed(2);
    var result = panel.querySelector('[data-a54-result]');
    panel.querySelector('[data-a54-offer-form]')?.remove();
    setPanelMessage(panel, data.message || 'Wie wäre es mit diesem Preis?', 'normal');
    if (!result) return;
    result.innerHTML = [
      '<strong>Unser Angebot: ', formatEUR(price), '</strong>',
      '<button type="button" class="a54-quick-bid-submit" data-a54-counter-accept>ANGEBOT ANNEHMEN</button>',
      '<small data-a54-counter-timer>30:00 gültig</small>'
    ].join('');
    var expiresAt = Date.now() + 30 * 60 * 1000;
    var timer = result.querySelector('[data-a54-counter-timer]');
    counterTimer = window.setInterval(function () {
      var seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      if (timer) timer.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + ' gültig';
      if (!seconds) {
        stopCounterTimer();
        var accept = result.querySelector('[data-a54-counter-accept]');
        if (accept) accept.disabled = true;
        setPanelMessage(panel, 'Das Gegenangebot ist abgelaufen.', 'error');
      }
    }, 1000);
  }

  function formatEUR(value) {
    return Number(value).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  }

  function showResponse(panel, data) {
    if (data.action === 'ACCEPT' || data.action === 'ACCEPT_NO_CODE') {
      showAccepted(panel, data);
      return;
    }
    if (data.action === 'COUNTER') {
      showCounter(panel, data);
      return;
    }
    setPanelMessage(panel, data.message || 'Das Angebot konnte nicht angenommen werden.', 'error');
  }

  async function submitOffer(panel, input) {
    var amount = Number(input.value);
    var variantId = panel.dataset.variantId;
    if (!Number.isFinite(amount) || amount <= 0 || !variantId) {
      setPanelMessage(panel, 'Bitte geben Sie ein gültiges Angebot ein.', 'error');
      return;
    }
    var submit = panel.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      var response = await fetch(OFFER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: panel.dataset.productId, variantId: variantId, amount: amount })
      });
      showResponse(panel, await response.json());
    } catch {
      setPanelMessage(panel, 'Verbindung fehlgeschlagen. Bitte versuchen Sie es erneut.', 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function acceptCounter(panel, button) {
    button.disabled = true;
    try {
      var response = await fetch(COUNTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: panel.dataset.productId,
          variantId: panel.dataset.variantId,
          counterPrice: panel.dataset.counterPrice
        })
      });
      showResponse(panel, await response.json());
    } catch {
      setPanelMessage(panel, 'Verbindung fehlgeschlagen. Bitte versuchen Sie es erneut.', 'error');
      button.disabled = false;
    }
  }

  function bindPanel(panel, content) {
    panel.addEventListener('click', function (event) {
      var launch = event.target.closest('[data-a54-open-offer]');
      if (launch) {
        showForm(panel);
        return;
      }
      var button = event.target.closest('[data-a54-counter-accept]');
      if (button) acceptCounter(panel, button);
    });
    if (content.dataset.a54QuickBidVariantListener !== 'true') {
      content.dataset.a54QuickBidVariantListener = 'true';
      content.addEventListener('change', function () {
        var currentPanel = content.querySelector('[data-a54-quick-bid-panel]');
        if (currentPanel) {
          currentPanel.dataset.variantId = readVariantId(content, currentPanel.dataset.variantId);
        }
      });
    }
  }

  async function openOffer(button, event) {
    event.preventDefault();
    event.stopPropagation();
    var card = button.closest('product-card');
    var quickAdd = card && card.querySelector('quick-add-component');
    if (!quickAdd || typeof quickAdd.handleClick !== 'function') {
      button.setAttribute('aria-invalid', 'true');
      return;
    }
    button.disabled = true;
    try {
      await quickAdd.handleClick(event);
      var content = await waitForModalContent();
      stopCounterTimer();
      content.querySelector('[data-a54-quick-bid-panel]')?.remove();
      var panel = panelShell();
      panel.dataset.productId = button.dataset.productId;
      panel.dataset.variantId = readVariantId(content, button.dataset.variantId);
      var productDetails = content.querySelector('.product-details');
      var offerHost = productDetails || content;
      panel.style.setProperty('display', 'block', 'important');
      panel.style.setProperty('min-width', '0', 'important');
      if (offerHost === content) {
        panel.style.setProperty('grid-column', '1 / -1', 'important');
      }
      var cartBlock = productDetails && productDetails.querySelector('.buy-buttons-block');
      if (cartBlock && cartBlock.parentElement) {
        cartBlock.parentElement.insertBefore(panel, cartBlock.nextSibling);
      } else {
        offerHost.append(panel);
      }
      bindPanel(panel, content);
    } catch (error) {
      console.error('[Archive54] Quick Bid modal error:', error);
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-a54-quick-bid]');
    if (button) openOffer(button, event);
  });

  window.A54QuickBid = { openOffer: openOffer };
})();
