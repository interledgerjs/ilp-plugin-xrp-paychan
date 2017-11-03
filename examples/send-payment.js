'use strict'

// IMPORTANT: execute `npm install ilp` before running this example
const {ILQP, IPR} = require('ilp')
const uuid = require('uuid')

const Store = require('ilp-plugin-payment-channel-framework/test/helpers/objStore')
const PluginRipple = require('../index')

const SHARED_SECRET = 'shh its a secret'
const SERVER_HOST = 'localhost'
const SERVER_PORT = 3000

// common config options for both peers
const COMMON_OPTS = {
  maxBalance: 'Infinity',
  settleDelay: 10,
  token: 'shared_secret',

  // This is the server that ripple-lib submits transactions to.  You can
  // configure this to point at the altnet or to point at the live net.
  rippledServer: 'wss://s.altnet.rippletest.net:51233',

  // limit of how much can be owed in-flight to you at once before you stop
  // accepting more incoming transfers. (in XRP drops)
  maxUnsecured: '5000000',

  // how much to fund your payment channel. (in XRP drops)
  maxAmount: '10000000'
}

const clientPlugin = new PluginRipple(Object.assign({}, COMMON_OPTS, {
  // This plugin's ripple address and secret.
  // Get testnet credentials at https://ripple.com/build/xrp-test-net/
  address: 'ra631F5oJWGsVcP9UQTi4mDgW1WymNY37P',
  secret: 'sscERuB78h5uwM3HUwFyFXSomauod',

  // The peer you want to start a payment channel with
  peerAddress: 'rwxiPbJYsFFpjnJrXxWKWybrZvP3HRMnmf',

  // Our peer acts as BTP server. This is the address he is listening on
  server: `btp+ws://:${SHARED_SECRET}@${SERVER_HOST}:${SERVER_PORT}`,

  // Other options. For details see:
  // https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md#class-pluginoptions
  _store: new Store()
}))

const serverPlugin = new PluginRipple(Object.assign({}, COMMON_OPTS, {
  // This plugin's ripple address and secret.
  // Get testnet credentials at https://ripple.com/build/xrp-test-net/
  address: 'rwxiPbJYsFFpjnJrXxWKWybrZvP3HRMnmf',
  secret: 'sstX7EXQh7ECXS2aqqsLwgQ8CF924',

  // The peer you want to start a payment channel with
  peerAddress: 'ra631F5oJWGsVcP9UQTi4mDgW1WymNY37P',

  // Other options. For details see:
  // https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md#class-pluginoptions
  _store: new Store(),
  listener: {
    port: SERVER_PORT
  },
  incomingSecret: SHARED_SECRET,
  prefix: 'g.xrp.mypaychan.',
  info: {
    prefix: 'g.xrp.mypaychan.',
    currencyScale: 6,
    currencyCode: 'XRP',
    connector: []
  }
}))

;(async function pay () {
  // establish a connection
  await Promise.all([clientPlugin.connect(), serverPlugin.connect()])

  try {
    const stopListening = await IPR.listen(serverPlugin, {
      receiverSecret: Buffer.from('secret', 'utf8')
    }, async function ({ transfer, fulfill }) {
      console.log('got transfer:', transfer)

      console.log('claiming incoming funds...')
      await fulfill()
      console.log('funds received!')
      stopListening()
    })

    const ipr = IPR.createIPR({
      receiverSecret: Buffer.from('secret', 'utf8'),
      destinationAccount: clientPlugin.getPeerAccount(),
      // denominated in the ledger's base unit
      destinationAmount: '10'
    })

    const { packet, condition } = IPR.decodeIPR(ipr)
    const quote = await ILQP.quoteByPacket(clientPlugin, packet)
    console.log('got quote:', quote)

    await clientPlugin.sendTransfer({
      id: uuid(),
      to: quote.connectorAccount,
      amount: quote.sourceAmount,
      // expiresAt: quote.expiresAt,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      executionCondition: condition,
      ilp: packet
    })

    clientPlugin.on('outgoing_fulfill', (transfer, fulfillment) => {
      console.log(transfer.id, 'was fulfilled with', fulfillment)
    })
  } catch (err) {
    console.log(err)
  }
})()
