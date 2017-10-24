const {EventEmitter} = require('events');
const fix = require('fixjs');
const tls = require('tls');
const crypto = require('crypto');
const Msgs = fix.Msgs;

class FIXClient extends EventEmitter {
  constructor(productID,
              fixURI = 'fix.gdax.com:4198',
              authenticatedClient = null) {
    super();

    let auth = null;
    this.productID = productID;
    this.fixURI = fixURI;

    if (authenticatedClient) {
      auth = {
        key: authenticatedClient.key,
        secret: authenticatedClient.b64secret,
        passphrase: authenticatedClient.passphrase,
      };
    }

    if (!(auth.secret && auth.key && auth.passphrase)) {
      throw new Error(
        'Invalid or incomplete authentication credentials. You should either provide all of the secret, key and passphrase fields'
      );
    }
    this.auth = auth;

    this._typeMap = {
      'market': 1,
      'limit': 2,
      'stop': 3,
    };

    this.connect();
  }

  connect() {
    const parts = this.fixURI.split(':');

    if (parts.length !== 2) throw new Error('Invalid FIX URI');

    const host = parts[0];
    const port = parts[1];

    // Connect via TLS.
    this.stream = tls.connect({
      host: host,
      port: port
    }, () => {
      // Create FIX client and session.
      this.client = fix.createClient(this.stream);
      this.session = this.client.session(this.auth.key, 'Coinbase');

      // Setup event handlers.
      this.session.on('Logon', (msg, next) => {
        this.onMessage({
          type: "logon"
        });
        this.onOpen();
        //this.sendOrder(2, 1, 5884.99, 0.01);
        next();
      });

      this.session.on('Logout', (msg, next) => {
        this.onMessage({
          type: "logout"
        });
        next();
      });

      this.session.on('TestRequest', (msg, next) => {
        this.onMessage({
          type: "test-request",
          msg: msg,
        });
        next();
      });

      this.session.on('ExecutionReport', (msg, next) => {
        const execType = msg.ExecType;
        if (execType == 0) { // New
          this.onMessage({
            type: "received",
            product_id: msg.Symbol,
            order_id: msg.OrderID,
            client_oid: msg.ClOrdID,
            price: msg.Price,
            size: msg.OrderQty,
            side: getSide(msg.Side),
          });
        } else if (execType == 1) { // Fill
          this.onMessage({
            type: "match",
            product_id: msg.Symbol,
            order_id: msg.OrderID,
            price: msg.Price,
            size: msg.LastShares,
            side: getSide(msg.Side),
          });
        } else if (execType == 3 || execType == 4) { // Done & Canceled
          this.onMessage({
            type: "done",
            product_id: msg.Symbol,
            order_id: msg.OrderID,
            price: msg.Price,
            size: msg.OrderQty,
            side: getSide(msg.Side),
            done_reason: execType == 3 ? "filled" : "canceled"
          });
        } else if (execType == 8) { // Rejected
          this.onMessage({
            type: "rejected",
            product_id: msg.Symbol,
            client_oid: msg.ClOrdID,
            order_id: msg.OrderID,
            price: msg.Price,
            size: msg.OrderQty,
            side: getSide(msg.Side),
            message: msg.Text, // "post only" "Insufficient funds"
          });
        } else if (execType === 'D') { // unsolicited reduce
          // Order Changed (self trade prevention)
        } else if (execType === 'I') {
          // Order Status
        }
        next();
      });

      this.session.on('OrderCancelReject', (msg, next) => {
        console.log(msg);
        this.onMessage({
          type: "order-cancel-reject",
          request_oid: msg.ClOrdID,
          order_id: msg.OrderID,
          too_late: msg.CxlRejResponseTo == "1"
        });
        next();
      });

      // Sent by either side upon receipt of a message which cannot be processed, e.g.
      // due to missing fields or an unsupported message type.
      this.session.on('Reject', (msg, next) => {
        this.onMessage({
          type: "message-reject",
          ref_type: msg.RefMsgType,
          text: msg.Text,
        });
        next();
      });

      this.session.on('end', () => {
        this.stream.end();
      });

      this.session.on('error', this.onError.bind(this));
      this.stream.on('end', this.onClose.bind(this));
      this.stream.on('error', this.onError.bind(this));

      this._login();
    });

    function getSide(side) {
      return parseInt(side, 10) === 1 ? "buy" : "sell";
    }
  }

  buy(params) {
    params.side = 'buy';
    return this._placeOrder(params);
  }

  sell(params) {
    params.side = 'sell';
    return this._placeOrder(params);
  }

  cancelOrder(request_id, client_oid, order_id) {
    const cancel = new Msgs.OrderCancelRequest(); 
    cancel.Symbol = this.productID;
    cancel.OrigClOrdID = client_oid;
    cancel.ClOrdID = request_id;
    cancel.OrderID = order_id;
    
    this.session.send(cancel);
  }


  _placeOrder(params) {
    const order = new Msgs.NewOrderSingle();
    order.Symbol = this.productID;
    if (params.client_oid)
      order.ClOrdID = params.client_oid;
    order.Side = params.side;
    order.HandlInst = 1;
    order.TransactTime = new Date();
    order.OrdType = this._typeMap[params.type];
    order.OrderQty = params.size;
    order.Price = params.price;
    order.TimeInForce = 'P'; // Post only.
    if (params.post_only === false)
      order.TimeInForce = '1'; // GTC

    order.set(7928, 'D'); // STP
    this.session.send(order);
  }
  
  onMessage(data) {
    console.log(data);
    this.emit('message', data);
  }

  onError(err) {
    if (!err) {
      return;
    }

    console.log("FIX Error: " + err);

    this.emit('error', err);
  }

  onOpen() {
    this.emit('open');
  }

  onClose() {
    this.stream = null;
    this.client = null;
    this.session = null;

    this.emit('close');
  }

  _login() {
    const logon = new Msgs.Logon();
    logon.SendingTime = new Date();
    logon.HeartBtInt = 30;
    logon.EncryptMethod = 0;
    logon.set(554, this.auth.passphrase);

    const presign = [
      logon.SendingTime,
      logon.MsgType,
      this.session.outgoing_seq_num,
      this.session.sender_comp_id,
      this.session.target_comp_id,
      this.auth.passphrase
    ].join('\x01');

    logon.RawData = this._sign(presign, this.auth.secret);
    this.session.send(logon, true);
  }

  _sign(what, secret) {
    const key = Buffer(secret, 'base64');
    const hmac = crypto.createHmac('sha256', key);
    return hmac.update(what).digest('base64');
  }

}

module.exports = exports = FIXClient;
