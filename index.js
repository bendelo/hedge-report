var request = require('request');
var crypto = require('crypto');

var apiKey = "";
var apiSecret = "";

function call(verb, path, data, callback) {
  var expires = new Date().getTime() + (60 * 1000); // 1 min in the future

  // Pre-compute the postBody so we can be sure that we're using *exactly* the same body in the request
  // and in the signature. If you don't do this, you might get differently-sorted keys and blow the signature.
  var postBody = JSON.stringify(data);

  var signature = crypto.createHmac('sha256', apiSecret).update(verb + path + expires + postBody).digest('hex');

  var headers = {
    'content-type' : 'application/json',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    // This example uses the 'expires' scheme. You can also use the 'nonce' scheme. See
    // https://www.bitmex.com/app/apiKeysUsage for more details.
    'api-expires': expires,
    'api-key': apiKey,
    'api-signature': signature
  };

  request.get({
      headers: headers,
      url:'https://www.bitmex.com'+path,
      method: verb,
      body: postBody
    },
    function(error, response, body) {
      if (error) {
        console.log(error);
      } else {
        var result = JSON.parse(body);
        callback(result);
      }
    }
  );
}

function show(margin, position) {
  var marginBalanceXBT = margin.marginBalance / 1e8;
  var marginBalanceUSD = marginBalanceXBT * position.markPrice;

  var hedgedXBT = position.homeNotional;
  var hedgedUSD = position.foreignNotional;

  var unhedgedXBT = marginBalanceXBT + position.homeNotional;
  var unhedgedUSD = unhedgedXBT * position.markPrice;

  var realisedPnlXBT = (position.rebalancedPnl + position.realisedPnl) / 1e8;
  var realisedPnlUSD = realisedPnlXBT * position.markPrice;

  console.log("Margin Balance: " + format(marginBalanceUSD) + " USD");
  console.log("Hedged:         " + format(hedgedUSD)        + " USD");
  console.log("Unhedged:       " + format(unhedgedUSD)      + " USD");
}

function format(number) {
  return ("         " + Math.round(number).toLocaleString()).slice(-9);
}

// Start it off
call('GET', '/api/v1/user/margin', {filter: {currency: "XBt"}},
  function(result) {
    var margin = result;
    call('GET', '/api/v1/position', {filter: {symbol: "XBTUSD"}},
      function(result) {
        var position = result[0];
        show(margin, position);
      }
    );
  }
);
