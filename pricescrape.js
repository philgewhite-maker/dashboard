// Loaded into an amazon.co.uk tab by the "Scrape price" bookmarklet (see
// Settings) -- NOT part of the dashboard's own app bundle, never imported
// by app.js, and not in sw.js's cache list, since it only ever runs in a
// DIFFERENT origin's page (Amazon's), fetched fresh via a cache-busting
// query string on every click so a fix here reaches the user's existing
// bookmarklet immediately, with nothing for them to re-copy.
//
// The bookmarklet itself is deliberately just a tiny loader
// (`javascript:(function(){var s=document.createElement('script');
// s.src='.../pricescrape.js?'+Date.now();document.body.appendChild(s);})();`)
// -- an earlier version inlined this whole script as one giant javascript:
// URI and it started getting rejected as "too long" wherever the user
// pasted it. A real, editable file here also means every future fix to
// Amazon's markup is a normal commit, not a re-generated wall of minified
// text handed over in chat each time.
(function () {
function text(sel) {
var el = document.querySelector(sel);
return el ? el.textContent.trim() : '';
}
var price = text('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen')
|| text('.priceToPay .a-offscreen')
|| text('#corePrice_feature_div .a-offscreen')
|| text('.a-price .a-offscreen')
|| text('#priceblock_ourprice')
|| text('#priceblock_dealprice');
if (!price) {
alert('No price found on this page — Amazon may have changed their layout, or this isn\'t a product page.');
return;
}

// Amazon renders TWO Subscribe & Save price blocks (#sns-base-price and
// #sns-tiered-price -- a base discount vs. a better "qualifying tier"
// discount) and hides whichever one doesn't apply to this account/item
// via class="aok-hidden" (zero layout, but still in the DOM) rather than
// removing it -- confirmed live against a real page where the tiered
// block was the hidden one and a different real page where the base
// block was. Reading "whichever one has a real ID" isn't enough; this
// checks which one is actually VISIBLE and reads that one.
function priceFromWrap(el) {
if (!el) return '';
var off = el.querySelector('.a-offscreen');
var offText = off ? off.textContent.trim() : '';
if (offText) return offText;
// Some accordion rows leave .a-offscreen blank and only populate the
// aria-hidden visible digit spans instead.
var whole = el.querySelector('.a-price-whole');
var frac = el.querySelector('.a-price-fraction');
var symbol = el.querySelector('.a-price-symbol');
if (whole && frac) {
var wholeText = (whole.textContent || '').replace(/\.$/, '').trim();
return (symbol ? symbol.textContent.trim() : '') + wholeText + '.' + frac.textContent.trim();
}
return '';
}
function visibleTierPrice(id) {
var c = document.getElementById(id);
if (!c || c.classList.contains('aok-hidden') || c.getClientRects().length === 0) return '';
return priceFromWrap(c.querySelector('.a-price') || c);
}
var subscribeSave = visibleTierPrice('sns-tiered-price') || visibleTierPrice('sns-base-price');
if (!subscribeSave) {
// Last-resort broad net for a layout this doesn't specifically recognize.
var any = document.querySelector('[id*="sns"] .a-price .a-offscreen');
subscribeSave = any ? any.textContent.trim() : '';
}

var name = text('#productTitle');
var url = location.origin + location.pathname;
var payload = 'DASHPRICE:' + JSON.stringify({ price: price, subscribeSave: subscribeSave, name: name, url: url });

function done() {
alert('Price copied: ' + price + (subscribeSave ? ' (Subscribe & Save: ' + subscribeSave + ')' : ' (no Subscribe & Save found)')
+ '\n\nSwitch to the dashboard and click "Paste price" on this item.');
}
if (navigator.clipboard && navigator.clipboard.writeText) {
navigator.clipboard.writeText(payload).then(done).catch(function () {
prompt('Copy this, then paste it into "Paste price":', payload);
});
} else {
prompt('Copy this, then paste it into "Paste price":', payload);
}
})();
