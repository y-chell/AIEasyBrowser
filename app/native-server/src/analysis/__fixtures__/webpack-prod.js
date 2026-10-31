(() => {
  'use strict';
  var e,
    t,
    r = {
      28: (e, t, r) => {
        function n(e, t) {
          return e + '?sig=' + btoa(t + e);
        }
        r.d(t, { t: () => o, z: () => n });
        const o = '/api/v1';
      },
    },
    n = {};
  function o(e) {
    var t = n[e];
    if (void 0 !== t) return t.exports;
    var a = (n[e] = { exports: {} });
    return (r[e](a, a.exports, o), a.exports);
  }
  ((o.m = r),
    (o.d = (e, t) => {
      for (var r in t)
        o.o(t, r) && !o.o(e, r) && Object.defineProperty(e, r, { enumerable: !0, get: t[r] });
    }),
    (o.f = {}),
    (o.e = (e) => Promise.all(Object.keys(o.f).reduce((t, r) => (o.f[r](e, t), t), []))),
    (o.u = (e) => 'lazy.chunk.js'),
    (o.o = (e, t) => Object.prototype.hasOwnProperty.call(e, t)),
    (e = {}),
    (t = 'gen:'),
    (o.l = (r, n, a, i) => {
      if (e[r]) e[r].push(n);
      else {
        var l, u;
        if (void 0 !== a)
          for (var s = document.getElementsByTagName('script'), d = 0; d < s.length; d++) {
            var c = s[d];
            if (c.getAttribute('src') == r || c.getAttribute('data-webpack') == t + a) {
              l = c;
              break;
            }
          }
        (l ||
          ((u = !0),
          ((l = document.createElement('script')).charset = 'utf-8'),
          (l.timeout = 120),
          o.nc && l.setAttribute('nonce', o.nc),
          l.setAttribute('data-webpack', t + a),
          (l.src = r)),
          (e[r] = [n]));
        var p = (t, n) => {
            ((l.onerror = l.onload = null), clearTimeout(f));
            var o = e[r];
            if (
              (delete e[r],
              l.parentNode && l.parentNode.removeChild(l),
              o && o.forEach((e) => e(n)),
              t)
            )
              return t(n);
          },
          f = setTimeout(p.bind(null, void 0, { type: 'timeout', target: l }), 12e4);
        ((l.onerror = p.bind(null, l.onerror)),
          (l.onload = p.bind(null, l.onload)),
          u && document.head.appendChild(l));
      }
    }),
    (o.r = (e) => {
      ('undefined' != typeof Symbol &&
        Symbol.toStringTag &&
        Object.defineProperty(e, Symbol.toStringTag, { value: 'Module' }),
        Object.defineProperty(e, '__esModule', { value: !0 }));
    }),
    (o.p = '/analysis/'),
    (() => {
      var e = { 792: 0 };
      o.f.j = (t, r) => {
        var n = o.o(e, t) ? e[t] : void 0;
        if (0 !== n)
          if (n) r.push(n[2]);
          else {
            var a = new Promise((r, o) => (n = e[t] = [r, o]));
            r.push((n[2] = a));
            var i = o.p + o.u(t),
              l = new Error();
            o.l(
              i,
              (r) => {
                if (o.o(e, t) && (0 !== (n = e[t]) && (e[t] = void 0), n)) {
                  var a = r && ('load' === r.type ? 'missing' : r.type),
                    i = r && r.target && r.target.src;
                  ((l.message = 'Loading chunk ' + t + ' failed.\n(' + a + ': ' + i + ')'),
                    (l.name = 'ChunkLoadError'),
                    (l.type = a),
                    (l.request = i),
                    n[1](l));
                }
              },
              'chunk-' + t,
              t,
            );
          }
      };
      var t = (t, r) => {
          var n,
            a,
            [i, l, u] = r,
            s = 0;
          if (i.some((t) => 0 !== e[t])) {
            for (n in l) o.o(l, n) && (o.m[n] = l[n]);
            u && u(o);
          }
          for (t && t(r); s < i.length; s++)
            ((a = i[s]), o.o(e, a) && e[a] && e[a][0](), (e[a] = 0));
        },
        r = (self.webpackChunkgen = self.webpackChunkgen || []);
      (r.forEach(t.bind(null, 0)), (r.push = t.bind(null, r.push.bind(r))));
    })());
  var a = o(28);
  window.aebAnalysis = {
    run() {
      const e = (0, a.z)(a.t + '/items', 'k1');
      return fetch(e).then((e) => e.status);
    },
    lazy: () =>
      o
        .e(245)
        .then(o.bind(o, 598))
        .then((e) => e.lazyHello('aeb')),
  };
})();
//# sourceMappingURL=webpack-prod.js.map
