# ilp-plugin-xrp-paychan

Uses payment channels on ripple to do fast ILP transactions between you and a
peer. Current in-flight payments are at risk (your peer can choose not to give
you claims for them), but are secured against the ledger as soon as you get a
claim.

**Warning: This plugin is still in a development state.**

# Example

This is how to instantiate a plugin:

```js
const PluginXrpPaychan = require('ilp-plugin-xrp-paychan')
const Store = require('ilp-plugin-payment-channel-framework/test/helpers/objStore')

const plugin = new PluginXrpPaychan({

  // If you want your peer to connect to you as a ws client (which doesn't
  // change the nature of the liquidity relationship) set the `listener`
  // argument in the constructor.
  listener: {
    port: 666,
    secret: 'its_a_secret' // this is the token that your peer must authenticate with.
  },

  // If you wish to connect to your peer as a ws client, specify the server option.
  // You may specify both the server and client options; in that case it is not deterministic
  // which peer will end up as the ws client.
  server: 'btp+ws://:its_a_secret@localhost:666',

  // Specify the server that you submit XRP transactions to.
  rippledServer: 'wss://s.altnet.rippletest.net:51233',

  // XRP address and secret
  secret: 's...',
  address: 'r...',

  // Peer's XRP address
  peerAddress: 'r...',

  // Store in which to save claims and channel details. This will be passed in
  // automatically if you're using the ILP connector.
  _store: new Store()
})

plugin.connect().then(() => {
  // do something with your plugin
  return plugin.sendData(/* ... */)
})
```
