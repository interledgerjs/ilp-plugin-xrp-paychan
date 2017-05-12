# ilp-plugin-xrp-paychan

Uses payment channels on ripple to do fast ILP transactions between you and a
peer.  Current in-flight payments are at risk (your peer can choose not to give
you claims for them), but if the amount in-flight exceeds your `inFlightLimit`,
you won't acknowledge incoming transfers until you're paid.

# Example

```js
const PluginRipple = require('ilp-plugin-paychan')

new PluginRipple({
  // This is the server that ripple-lib submits transactions to.  You can
  // configure this to point at the altnet or to point at the live net.
  server: 'wss://s.altnet.rippletest.net:51233',

  // Your ripple address and secret
  address: 'r33L6z6LMD8Lk39iEQhyXeSWqNN7pFVaM6',
  secret: 'ssyFYib1wv4tKrYfQEARxGREH6T3b',

  // The peer you want to start a payment channel with
  peerAddress: 'rhxcezvTxiANA3TkxBWpx923M5zQ4RZ9gJ',

  // secret for ed25519 secret key
  channelSecret: 'shh its a secret',

  // limit of how much can be owed in-flight to you at once before you stop
  // accepting more incoming transfers. (in XRP drops)
  maxInFlight: '5000000',

  // how much to fund your payment channel. (in XRP drops)
  channelAmount: '10000000'

  // RPC calls to the peer on the other side of the channel are sent to this
  // endpoint using HTTP.
  rpcUri: 'http://example.com/rpc'

  // store is used to keep local state, which is necessary because the plugin
  // works based on off-chain payment channel claims. `get`, `put`, and `del`
  // are asynchronous functions for accessing a key-value store. See
  // https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md#class-pluginoptions
  _store: {
    get: function (k) { /* ... */ },
    put: function (k, v) { /* ... */ },
    del: function (k) { /* ... */ }
  }
})
```
