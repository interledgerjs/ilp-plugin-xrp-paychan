'use strict'

const PluginRipple = require('ilp-plugin-xrp-paychan')
const Store = require('ilp-plugin-payment-channel-framework/test/helpers/objStore')

const plugin = new PluginRipple({
  // This is the server that ripple-lib submits transactions to.  You can
  // configure this to point at the altnet or to point at the live net.
  rippledServer: 'wss://s.altnet.rippletest.net:51233',

  // Your ripple address and secret
  address: 'r33L6z6LMD8Lk39iEQhyXeSWqNN7pFVaM6',
  secret: 'ssyFYib1wv4tKrYfQEARxGREH6T3b',

  // The peer you want to start a payment channel with
  peerAddress: 'rhxcezvTxiANA3TkxBWpx923M5zQ4RZ9gJ',

  // limit of how much can be owed in-flight to you at once before you stop
  // accepting more incoming transfers. (in XRP drops)
  maxUnsecured: '50000',

  // how much to fund your payment channel. (in XRP drops)
  maxAmount: '10000000',

  // highest balance allowed
  maxBalance: 'Infinity',

  // Our peer's BTP server address.
  server: 'btp+ws://alice:password@mypeer.example',

  // store is used to keep local state, which is necessary because the plugin
  // works based on off-chain payment channel claims. `get`, `put`, and `del`
  // are asynchronous functions for accessing a key-value store. See
  // https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md#class-pluginoptions
  _store: new Store()
})

plugin.connect().then(() => {
  // do something with your plugin
})
