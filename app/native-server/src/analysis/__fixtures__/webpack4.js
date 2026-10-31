!(function (e) {
  var t = {};
  function n(r) {
    if (t[r]) return t[r].exports;
    var o = (t[r] = { i: r, l: !1, exports: {} });
    return (e[r].call(o.exports, o, o.exports, n), (o.l = !0), o.exports);
  }
  n((n.s = 1));
})([
  function (e, t) {
    e.exports = function (e) {
      return 2 * e;
    };
  },
  function (e, t, n) {
    var r = n(0);
    console.log(r(21));
  },
]);
