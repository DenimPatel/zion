/* thing.js — an IIFE-wrapped module, which is the shape that breaks a strict
 * depth-0 declaration rule. Two functions inside should still be two floors. */
(function (global) {
  "use strict";

  function makeThing(name) {
    return { name: name, kind: "thing" };
  }

  const describe = function (thing) {
    return thing.name + " is a " + thing.kind;
  };

  global.makeThing = makeThing;
  global.describe = describe;
})(window);
