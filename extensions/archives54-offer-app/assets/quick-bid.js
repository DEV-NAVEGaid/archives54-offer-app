(function () {
  if (window.A54QuickBid) return;

  var OFFER_URL = '/apps/archives54-offer-app/offers';
  var COUNTER_URL = '/apps/archives54-offer-app/offers/counter-accept';
  var STATE_URL = '/apps/archives54-offer-app/offers/state';
  var MODAL_CONTENT_ID = 'quick-add-modal-content';
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

  function removeOfferForm(panel) {
    panel.querySelector('[data-a54-offer-form]')?.remove();
  }

  function panelShell() {
    var panel = document.createElement('section');
    panel.className = 'a54-quick-bid-panel';
    panel.dataset.a54QuickBidPanel = 'true';
    showForm(panel);
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

  function showCounter(panel, data) {
    var price = Number(data.counterPrice);
    panel.dataset.counterPrice = price.toFixed(2);
    var result = panel.querySelector('[data-a54-result]');
    panel.querySelector('[data-a54-offer-form]')?.remove();
    setPanelMessage(panel, data.message || 'Wie wäre es mit diesem Preis?', 'normal');
    if (!result) return;
    result.innerHTML = [
      '<strong>Unser Angebot: ', formatEUR(price), '</strong>',
      '<button type="button" class="a54-quick-bid-submit" data-a54-counter-accept>ANGEBOT ANNEHMEN</button>'
    ].join('');
  }

  function formatEUR(value) {
    return Number(value).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  }

  async function showResponse(panel, data) {
    if (data.action === 'ACCEPT' || data.action === 'ACCEPT_NO_CODE') {
      await showAccepted(panel, data);
      return;
    }
    if (data.action === 'COUNTER') {
      await saveState(panel, 'counter', {
        amountStr: panel.dataset.offerAmount || '',
        counterPrice: data.counterPrice,
        message: data.message,
        expiresAt: Date.now() + 30 * 60 * 1000
      });
      showCounter(panel, data);
      return;
    }
    if (data.action === 'DECLINE') {
      removeOfferForm(panel);
      await saveState(panel, 'declined', { amountStr: panel.dataset.offerAmount || '' });
    }
    setPanelMessage(panel, data.message || 'Das Angebot konnte nicht angenommen werden.', 'error');
  }

  async function saveState(panel, state, data) {
    var customerId = panel.dataset.customerId;
    if (!customerId) return;
    try {
      await fetch(STATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId,
          productId: panel.dataset.productId,
          state: state,
          data: data || {}
        })
      });
    } catch {
      // Offer enforcement is server-side; state persistence is best effort.
    }
  }

  async function loadState(button) {
    var customerId = button.dataset.customerId;
    if (!customerId) return null;
    try {
      var response = await fetch(
        STATE_URL + '?customerId=' + encodeURIComponent(customerId) +
        '&productId=' + encodeURIComponent(button.dataset.productId)
      );
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  function showSavedState(panel, saved) {
    var data = saved.data || {};
    removeOfferForm(panel);
    if (saved.state === 'counter' && data.counterPrice) {
      showCounter(panel, data);
      return;
    }
    var result = panel.querySelector('[data-a54-result]');
    if (saved.state === 'accepted' && data.discountCode) {
      setPanelMessage(panel, 'Ihr Angebot wurde bereits akzeptiert.', 'success');
      if (result) result.innerHTML = '<div class="a54-quick-bid-code">' + data.discountCode + '</div>';
      return;
    }
    if (saved.state === 'accepted_no_code') {
      setPanelMessage(panel, 'Ihr Angebot wurde bereits akzeptiert. Sie können direkt zum Sale-Preis kaufen.', 'success');
      return;
    }
    setPanelMessage(panel, data.message || 'Sie haben bereits ein Angebot für dieses Produkt abgegeben.', 'error');
  }

  function readCartQuantity(panel) {
    var content = panel.closest('#' + MODAL_CONTENT_ID);
    var input = content && content.querySelector('input[name="quantity"]');
    var minimum = input && Number(input.min) > 0 ? Number(input.min) : 1;
    var maximum = input && Number(input.max) > 0 ? Number(input.max) : Infinity;
    var value = input ? Number(input.value) : minimum;
    if (!Number.isFinite(value)) value = minimum;
    return Math.min(maximum, Math.max(minimum, Math.floor(value)));
  }

  function readNumericVariantId(value) {
    var match = String(value || '').match(/(\d+)$/);
    return match ? Number(match[1]) : NaN;
  }

  async function addAcceptedToCart(panel, data) {
    var variantId = readNumericVariantId(panel.dataset.variantId);
    if (!Number.isSafeInteger(variantId) || variantId <= 0) {
      setPanelMessage(panel, 'Die ausgewählte Variante ist nicht verfügbar.', 'error');
      return;
    }
    setPanelMessage(panel, 'Wird in den Warenkorb gelegt...', 'normal');
    try {
      var response = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: variantId, quantity: readCartQuantity(panel) }] })
      });
      if (!response.ok) throw new Error('Cart add failed');
      var cartUrl = data.discountCode
        ? '/discount/' + encodeURIComponent(data.discountCode) + '?redirect=' + encodeURIComponent('/cart')
        : '/cart';
      window.location.assign(cartUrl);
    } catch {
      setPanelMessage(panel, 'Der Artikel konnte nicht in den Warenkorb gelegt werden.', 'error');
    }
  }

  async function showAccepted(panel, data) {
    var result = panel.querySelector('[data-a54-result]');
    var code = data.discountCode
      ? '<div class="a54-quick-bid-code">' + data.discountCode + '</div>'
      : '<div class="a54-quick-bid-no-code">Kein Rabattcode erforderlich.</div>';
    removeOfferForm(panel);
    setPanelMessage(panel, data.message || 'Ihr Angebot wurde akzeptiert!', 'success');
    if (result) result.innerHTML = code;
    await saveState(panel, data.discountCode ? 'accepted' : 'accepted_no_code', {
      amountStr: panel.dataset.offerAmount || '',
      discountCode: data.discountCode || '',
      expiresAt: Date.now() + 30 * 60 * 1000
    });
    await addAcceptedToCart(panel, data);
  }

  async function submitOffer(panel, input) {
    var amount = Number(input.value);
    var variantId = panel.dataset.variantId;
    if (!Number.isFinite(amount) || amount <= 0 || !variantId) {
      setPanelMessage(panel, 'Bitte geben Sie ein gültiges Angebot ein.', 'error');
      return;
    }
    panel.dataset.offerAmount = amount.toFixed(2);
    var submit = panel.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      var response = await fetch(OFFER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: panel.dataset.productId, variantId: variantId, amount: amount })
      });
      await showResponse(panel, await response.json());
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
      await showResponse(panel, await response.json());
    } catch {
      setPanelMessage(panel, 'Verbindung fehlgeschlagen. Bitte versuchen Sie es erneut.', 'error');
      button.disabled = false;
    }
  }

  function bindPanel(panel, content) {
    panel.addEventListener('click', function (event) {
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
      content.querySelector('[data-a54-quick-bid-panel]')?.remove();
      var panel = panelShell();
      panel.dataset.productId = button.dataset.productId;
      panel.dataset.variantId = readVariantId(content, button.dataset.variantId);
      if (button.dataset.customerId) panel.dataset.customerId = button.dataset.customerId;
      var productDetails = content.querySelector('.product-details');
      var offerHost = productDetails || content;
      panel.style.setProperty('display', 'block', 'important');
      panel.style.setProperty('min-width', '0', 'important');
      if (offerHost === content) {
        panel.style.setProperty('grid-column', '1 / -1', 'important');
      }
      var cartBlock = productDetails && productDetails.querySelector('.buy-buttons-block');
      if (cartBlock && cartBlock.parentElement) {
        cartBlock.classList.add('a54-quick-bid-cart-hidden');
        cartBlock.parentElement.insertBefore(panel, cartBlock.nextSibling);
      } else {
        offerHost.append(panel);
      }
      bindPanel(panel, content);
      var saved = await loadState(button);
      if (saved && saved.state) showSavedState(panel, saved);
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
