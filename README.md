# ilp-plugin-paychan

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

  // peer's ed25519 public key for verifying signatures
  peerPublicKey: 'KRixgcBCBdyQln7IBYiopjuNO78QSFtXgOwP1sbsCSk',

  // limit of how much can be owed in-flight to you at once before you stop
  // accepting more incoming transfers. (in XRP)
  inFlightLimit: '10',

  // how much to fund your payment channel. TODO: keep funding the channel
  // to keep it going. (in XRP)
  fundAmount: '500'

  // store is used to keep local state, which is necessary because the plugin
  // works based on off-chain payment channel claims.
  _store: {
    get: function (k) { /* ... */ },
    put: function (k, v) { /* ... */ },
    del: function (k) { /* ... */ }
  }
})
```
