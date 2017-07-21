const debug = require('debug')('ilp-plugin-xrp')
const BigNumber = require('bignumber.js')
const RippleAPI = require('ripple-lib').RippleAPI
const IncomingChannel = require('./lib/incoming-channel')
const OutgoingChannel = require('./lib/outgoing-channel')

process.on('unhandledRejection', (e) => {
  console.error(e)
})

module.exports = {
  pluginName: 'xrp-paychan',

  constructor: function (ctx, opts) {
    const self = ctx.state

    self.maxUnsecured = opts.maxInFlight
    self.server = opts.server
    self.address = opts.address
    self.secret = opts.secret
    self.channelSecret = opts.channelSecret
    self.channelAmount = opts.channelAmount
    self.peerAddress = opts.peerAddress
    self.prefix = 'g.crypto.riple.paychan.' +
      ((self.address < self.peerAddress)
        ? self.address + '~' + self.peerAddress
        : self.peerAddress + '~' + self.address) + '.'

    self.api = new RippleAPI({ server: self.server })
    self.bestClaim = ctx.backend.getMaxValueTracker({ key: 'incoming_claim' })
    self.channelCreationStage = ctx.backend.getMaxValueTracker({ key: 'outgoing_channel' })

    self.incomingChannel = new IncomingChannel({
      api: self.api,
      address: self.address,
      secret: self.secret,
      bestClaim: self.bestClaim
    })

    self.outgoingChannel = new OutgoingChannel({
      api: self.api,
      address: self.address,
      secret: self.secret,
      channelSecret: self.channelSecret,
      destination: self.peerAddress,
      amount: self.channelAmount,
      channelCreationStage: self.channelCreationStage
    })

    self.outgoingChannel.on('fund', (tx) => {
      ctx.rpc.call('_fund', self.prefix, [ tx.hash ])
    })

    ctx.rpc.addMethod('_fund', () => {
      self.incomingChannel.reloadChannelDetails()
      return true
    })

    ctx.rpc.addMethod('_get_channel', () => {
      return self.outgoingChannel.getChannelId() || false
    })
  },

  getAuthToken: () => 'placeholder', // TODO
  getAccount: (ctx) => (ctx.state.prefix + ctx.state.address),
  getPeerAccount: (ctx) => (ctx.state.prefix + ctx.state.peerAddress), 
  getInfo: (ctx) => ({
    currencyCode: 'XRP',
    currencyScale: 6,
    prefix: ctx.state.prefix
  }),

  connect: async function (ctx) {
    debug('connecting to ripple API')
    const self = ctx.state

    await self.api.connect()
    await self.api.connection.request({
      command: 'subscribe',
      accounts: [ self.address ]
    })

    // TODO: how to load values from the store?
    await self.outgoingChannel.create()

    let incomingChannel = null
    while (!incomingChannel) {
      try {
        incomingChannel = await ctx.rpc.call('_get_channel', self.prefix, [ 'get_channel' ])
        debug('got result:', incomingChannel)
        if (typeof incomingChannel !== 'string') {
          throw new Error('got non-string response:' + JSON.stringify(incomingChannel))
        }
      } catch (e) {
        debug('get channel failed:', e.message, '. retrying...')
      }
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }

    debug('got incoming channel id from peer:', incomingChannel)
    await self.incomingChannel.create({ channelId: incomingChannel })
  },

  disconnect: async function (ctx) {
    debug('claiming outstanding funds before disconnect...')
    await ctx.state.incomingChannel._claimFunds()
  },

  handleIncomingPrepare: async function (ctx, transfer) {
    const self = ctx.state
    const incoming = await ctx.transferLog.getIncomingFulfilledAndPrepared()
    const bestClaim = await self.bestClaim.getMax()
    const channelLimit = self.incomingChannel.getMax()

    const exceedsUnsecured = new BigNumber(incoming)
      .subtract(bestClaim)
      .greaterThan(self.maxUnsecured)

    if (exceedsUnsecured) {
      throw new Error('transfer ' + transfer.id + ' would exceed maximum ' +
        'unsecured balance')
    }

    const exceedsMaximum = new BigNumber(incoming)
      .greaterThan(channelLimit)

    if (exceedsMaximum) {
      throw new Error('transfer ' + transfer.id + ' would exceed incoming ' +
        'channel\'s capacity')
    }
  },

  createOutgoingClaim: async function (ctx, outgoingBalance) {
    const self = ctx.state
    const claim = await self.outgoingChannel.createClaim(outgoingBalance)

    return { claim, outgoingBalance }
  },

  handleIncomingClaim: async function (ctx, claimResponse) {
    const self = ctx.state
    const balance = claimResponse.outgoingBalance
    const claim = claimResponse.claim

    await self.incomingChannel.receive({ balance, claim })
  }
}
