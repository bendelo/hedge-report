var request = require('request');
var crypto = require('crypto');
var minimist = require('minimist');
var credentials = require('./credentials');
var apiKey = credentials.apiKey;
var apiSecret = credentials.apiSecret;
var args = minimist(process.argv.slice(2), {float: 'coldwallet', boolean: 'reset1x', boolean: 'autohedge', boolean: 'force'});

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

  request({
      headers: headers,
      url: 'https://www.bitmex.com' + path,
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

function show(instrument, position, margin) {
  var marginBalanceXBT = (margin.marginBalance / 1e8) + (args.coldwallet || 0);
  var marginBalanceUSD = marginBalanceXBT * instrument.markPrice;

  var hedgedXBT = -position.homeNotional;
  var hedgedUSD =  position.foreignNotional;

  var unhedgedXBT = marginBalanceXBT - hedgedXBT;
  var unhedgedUSD = unhedgedXBT * instrument.markPrice;

  var availableMarginXBT = margin.availableMargin / 1e8;
  var availableMarginUSD = availableMarginXBT * instrument.markPrice;

  var profitXBT = (position.rebalancedPnl + position.realisedPnl) / 1e8;

  var hedgedPnlXBT = Math.max(0, Math.min(profitXBT - unhedgedXBT, profitXBT));
  var hedgedPnlUSD = hedgedPnlXBT * position.avgEntryPrice;

  var unhedgedPnlXBT = profitXBT - hedgedPnlXBT;
  var unhedgedPnlUSD = unhedgedPnlXBT * instrument.markPrice;

  var originalUSD  = hedgedUSD - hedgedPnlUSD;
  var profitUSD  = hedgedPnlUSD + unhedgedPnlUSD;
  var currentUSD   = originalUSD + profitUSD;
  var interestPcnt = profitUSD / originalUSD;

  console.log("Margin Balance: " + format(marginBalanceUSD)   + " USD");
  console.log("Hedged:         " + format(hedgedUSD)          + " USD");
  console.log("Unhedged:       " + format(unhedgedUSD)        + " USD");
  console.log("Available Bal.: " + format(availableMarginUSD) + " USD");
  console.log("");
  console.log("Original Value: " + format(originalUSD)        + " USD");
  console.log("Current  Value: " + format(currentUSD)         + " USD");
  console.log("Profit:         " + format(profitUSD)          + " USD");
  console.log("Profit Pcnt:    " + format(interestPcnt * 100) + " %");
  console.log("");

  var side = unhedgedUSD > 0 ? 'Sell' : 'Buy';
  var orderQty = Math.floor(Math.abs(unhedgedUSD));
  console.log("Hedge order:    " + "  " + side + " "  + orderQty + " contracts");

  var maxQty = Math.floor(position.leverage * Math.max(0, availableMarginUSD / (1 + position.commission + position.commission)));
  if ((Math.sign(hedgedUSD) == Math.sign(unhedgedUSD)) && orderQty > maxQty) {
    orderQty = Math.min(orderQty, maxQty);
    console.log("Hedge order:    " + "  " + side + " "  + orderQty + " contracts (reduced due to insufficient Available Balance)");
    if (!args.reset1x) {
      console.log("Try using --reset1x to reset position leverage to 1x");
    }
  }

  if (!orderQty) {
    console.log("No need to send hedge order.");
  } else if (!args.autohedge) {
    console.log("Use --autohedge to send hedge order.");
  } else if (!args.force && orderQty > 1000) {
    console.log("Use --force to send large hedge order.");
  } else {
    var order = {symbol: 'XBTUSD', side: side, orderQty: orderQty, ordType: 'Market', timeInForce: 'ImmediateOrCancel'};
    call('POST', '/api/v1/order', order,
      function(result) {
        if ('error' in result) {
          console.log("Error sending order: " + result.error.message);
        } else {
          var slippagePcnt = position.commission + (side == 'Buy' ? 1 : -1) * (result.avgPx / position.markPrice - 1);
          console.log("Filled Quantity:" + format(result.cumQty)      + " USD");
          console.log("Filled Price:   " + format(result.avgPx)       + " USD");
          console.log("Slippage Pcnt:  " + format(slippagePcnt * 100) + " %");
        }
      }
    );
  }
}

function format(number) {
  return ("         " + number.toFixed(2)).slice(-9);
}

var handleInstrument = function(result) {
  if ('error' in result) {
    console.log("Error getting instrument: " + result.error.message);
  } else {
    var instrument = result[0];
    if (args.reset1x) {
      call('POST', '/api/v1/position/leverage', {symbol: 'XBTUSD', leverage: 1}, function(result) { handlePosition(instrument, result) });
    } else {
      call('GET', '/api/v1/position', {filter: {symbol: 'XBTUSD'}}, function(result) { handlePosition(instrument, result) });
    }
  }
};

var handlePosition = function(instrument, result) {
  if ('error' in result) {
    if (args.reset1x) {
      console.log("Error setting 1x: " + result.error.message);
    } else {
      console.log("Error getting position: " + result.error.message);
    }
  } else {
    var position = Array.isArray(result) ? result[0] : result;
    if (position == undefined) {
      position = {
        homeNotional: 0,
        foreignNotional: 0,
        rebalancedPnl: 0,
        realisedPnl: 0,
        avgEntryPrice: null,
        commission: 0,
        markPrice: null,
      };
    }
    if (position.markPrice == null) {
      position.markPrice = instrument.markPrice;
    }
    call('GET', '/api/v1/user/margin', {filter: {currency: 'XBt'}}, function(result) { handleMargin(instrument, position, result) });
  }
};

var handleMargin = function(instrument, position, result) {
  if ('error' in result) {
    console.log("Error getting margin: " + result.error.message);
  } else {
    var margin = result;
    show(instrument, position, margin);
  }
};

// Start it off
call('GET', '/api/v1/instrument', {filter: {symbol: 'XBTUSD'}}, handleInstrument);
