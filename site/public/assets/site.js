/* PhoneMic site — shared i18n + chrome */
(function () {
  var KEY = "pm_site_lang";
  var TITLES = {};
  var DESC = {};

  function detect() {
    var q = new URLSearchParams(location.search).get("lang");
    if (q === "zh" || q === "en") return q;
    var stored = localStorage.getItem(KEY);
    if (stored === "zh" || stored === "en") return stored;
    return (navigator.language || "en").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }

  function apply(lang, dict) {
    var d = dict[lang] || {};
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var v = d[el.dataset.i18n];
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      // format: data-i18n-attr="placeholder:kPlaceholder"
      el.dataset.i18nAttr.split(",").forEach(function (pair) {
        var bits = pair.split(":");
        var v = d[bits[1]];
        if (v != null) el.setAttribute(bits[0], v);
      });
    });
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    if (TITLES[lang]) document.title = TITLES[lang];
    var md = document.querySelector('meta[name="description"]');
    if (md && DESC[lang]) md.content = DESC[lang];
    var og = document.querySelector('meta[property="og:locale"]');
    if (og) og.content = lang === "zh" ? "zh_CN" : "en_US";
    document.querySelectorAll(".lang").forEach(function (b) {
      b.textContent = lang === "zh" ? "English" : "中文";
    });
    try { localStorage.setItem(KEY, lang); } catch (e) {}
  }

  window.initSite = function (opts) {
    TITLES = opts.titles || {};
    DESC = opts.desc || {};
    var lang = detect();
    apply(lang, opts.i18n);
    document.querySelectorAll(".lang").forEach(function (b) {
      b.addEventListener("click", function () {
        lang = lang === "zh" ? "en" : "zh";
        var u = new URL(location.href);
        u.searchParams.set("lang", lang);
        history.replaceState(null, "", u);
        apply(lang, opts.i18n);
      });
    });
    var y = document.getElementById("year");
    if (y) y.textContent = new Date().getFullYear();
  };
})();
