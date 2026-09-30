// Static scanner demo. Never feed untrusted input to eval.
exports.calculate = expression => eval(expression);
