'use strict'

const { RippleAPI } = require('ripple-lib')
const addressCodec = require('ripple-address-codec')
const { makePaymentChannelPlugin } = require('ilp-plugin-payment-channel-framework')
const uuid = require('uuid')
const nacl = require('tweetnacl')
const crypto = require('crypto')
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest()
const bignum = require('bignum') // required in order to convert to buffer
const BigNumber = require('bignumber.js')
const debug = require('debug')('ilp-plugin-xrp-paychan')

const STATE_NO_CHANNEL = '0'
const STATE_CREATING_CHANNEL = '1'
const STATE_CHANNEL = '2'
const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time))
const randomTag = () => bignum.fromBuffer(crypto.randomBytes(4), {
  endian: 'big',
  size: 4
}).toNumber()

const encodeClaim = (amount, id) => Buffer.concat([
  Buffer.from('CLM\0'),
  Buffer.from(id, 'hex'),
  bignum(amount).toBuffer({
    endian: 'big',
    size: 8
  })
])

const computeChannelId = (src, dest, sequence) => {
  const preimage = Buffer.concat([
    Buffer.from('\0x', 'ascii'),
    Buffer.from(addressCodec.decodeAccountID(src)),
    Buffer.from(addressCodec.decodeAccountID(dest)),
    bignum(sequence).toBuffer({ endian: 'big', size: 4 })
  ])

  return crypto.createHash('sha512')
    .update(preimage)
    .digest()
    .slice(0, 32) // first half sha512
    .toString('hex')
    .toUpperCase()
}

const claimFunds = async (self, amount, signature) => {
  const txTag = randomTag()
  const tx = await self.api.preparePaymentChannelClaim(self.address, {
    balance: new BigNumber(amount).div(1000000).toString(),
    channel: self.incomingPaymentChannelId,
    signature: signature,
    publicKey: self.incomingPaymentChannel.publicKey
  })

  const signedTx = self.api.sign(tx.txJSON, self.secret)
  debug('submitting claim transaction ', tx)
  await self.api.submit(signedTx.signedTransaction)

  return new Promise((resolve) => {
    const handleTransaction = function (ev) {
      if (ev.transaction.SourceTag !== txTag) return
      if (ev.transaction.Account !== self.address) return

      // TODO: verify success status
      debug('successfully submitted claim', signature, 'for amount', amount)

      setImmediate(() => self.api.connection
        .removeListener('transaction', handleTransaction))
      resolve()
    }

    self.api.connection.on('transaction', handleTransaction)
  })
}

module.exports = makePaymentChannelPlugin({
  pluginName: 'xrp-paychan',

  constructor: function (ctx, opts) {
    const self = ctx.state
    self.api = new RippleAPI({ server: opts.server })
    self.address = opts.address
    self.secret = opts.secret
    self.peerAddress = opts.peerAddress
    self.maxUnsecured = opts.maxUnsecured
    self.channelAmount = opts.maxAmount
    self.fundPercent = opts.fundPercent
    self.claimPercent = opts.claimPercent
    self.prefix = opts.prefix // TODO: auto-generate prefix?
    self.peerPublicKey = opts.peerPublicKey // TODO: read the pub key from the result of getPaymentChannel?
    self.authToken = opts.token

    // TODO: figure out best way to create secure keypair
    self.keyPair = nacl.sign.keyPair.fromSeed(sha256(Buffer.from(self.secret)))
    self.outgoingChannel = ctx.backend.getMaxValueTracker('outgoing_channel')
    self.incomingClaim = ctx.backend.getMaxValueTracker('incoming_claim')
    self.incomingClaimSubmitted = ctx.backend.getMaxValueTracker('incoming_claim_submitted')

    ctx.rpc.addMethod('ripple_channel_id', () => {
      return self.outgoingPaymentChannelId || null     
    })
  },

  getAuthToken: (ctx) => (ctx.state.authToken),

  connect: async function (ctx) {
    const self = ctx.state
    await self.api.connect()

    await self.api.connection.request({
      command: 'subscribe',
      accounts: [ self.address, self.peerAddress ]
    })

    // establish channel
    const pluginId = uuid()
    const tryToCreate = { value: STATE_CREATING_CHANNEL, data: pluginId }
    const result = await self.outgoingChannel.setIfMax(tryToCreate)
    let channelId

    // if the payment channel has been created already
    if (result.value === STATE_CHANNEL) {
      channelId = result.data
    // if the payment channel has not been created and this process must create it
    } else if (result.value === STATE_NO_CHANNEL) {
      // create the channel
      const txTag = randomTag()
      let tx
      try {  
        tx = await self.api.preparePaymentChannelCreate(self.address, {
          // TODO: @sharafian, self.maxAmount is undefined, is ctx.plugin._opts.channelAmount correct ?
          // amount: new BigNumber(self.maxAmount).div(1000000).toString(),
          amount: new BigNumber(ctx.plugin._opts.channelAmount).div(1000000).toString(),
          destination: self.peerAddress,
          settleDelay: 60,
          publicKey: 'ED' + Buffer.from(self.keyPair.publicKey).toString('hex').toUpperCase(),
          sourceTag: txTag
        })
      } catch (e) {
        debug('Error preparing payment channel.', e)
        throw e
      }

      const signedTx = self.api.sign(tx.txJSON, self.secret)
      const {resultCode, resultMessage} = await self.api.submit(signedTx.signedTransaction)
      if (resultCode !== 'tesSUCCESS') {
        debug('Something went wrong creating the payment channel', resultMessage)
      }

      await new Promise((resolve) => {
        function handleTransaction (ev) {
          if (ev.transaction.SourceTag !== txTag) return
          if (ev.transaction.Account !== self.address) return

          channelId = computeChannelId(
            ev.transaction.Account,
            ev.transaction.Destination,
            ev.transaction.Sequence)

          setImmediate(() => self.api.connection
            .removeListener('transaction', handleTransaction))
          resolve()
        }

        self.api.connection.on('transaction', handleTransaction)
      })

      // setIfMax 2, channelId
      await self.outgoingChannel.setIfMax({ value: 2, data: channelId })

    // if another process in currently creating the channel
    } else if (result.value === STATE_CREATING_CHANNEL) {
      // poll for channelId
      while (self.outgoingChannel.getMax().value !== 2) { await sleep(5000) }
      channelId = self.outgoingChannel.getMax().data
    }

    // TODO: recreate channel if it doesn't exist
    self.outgoingPaymentChannelId = channelId
    self.outgoingPaymentChannel = await self.api.getPaymentChannel(channelId)

    // query peer until they have a channel id
    while (true) {
      self.incomingPaymentChannelId = await ctx.rpc.call('ripple_channel_id', self.prefix, [])
      if (self.incomingPaymentChannelId) break
      await sleep(5000)
    }

    // look up channel on ledger
    // TODO: if incoming channel doesn't exist, throw an error
    self.incomingPaymentChannel = await self.api.getPaymentChannel(self.incomingPaymentChannelId)
  },

  disconnect: async function (ctx) {
    const self = ctx.state
    // submit latest claim
    const { value, data } = await self.incomingClaim.getMax()
    try {
      await claimFunds(self, value, data)
    } catch (err) {
      debug(err)
    }


    // TODO: close channel?
    // return nothing
  },

  getAccount: ctx => ctx.state.prefix + ctx.state.address,
  getPeerAccount: ctx => ctx.state.prefix + ctx.state.peerAddress,
  getInfo: ctx => ({
        currencyCode: 'XRP',
        currencyScale: 6,
        prefix: ctx.state.prefix,
        connectors: [ ctx.state.prefix + ctx.state.peerAddress ]    
    }),

  handleIncomingPrepare: async function (ctx, transfer) {
    const self = ctx.state
    const incoming = await ctx.transferLog.getIncomingFulfilledAndPrepared()
    // TODO: figure out how to decode claim
    const amountSecured = await self.incomingClaim.getMax()

    // handle unsecured amount
    const exceeds = new BigNumber(incoming)
      .minus(amountSecured.value)
      .greaterThan(self.maxUnsecured)

    // make sure channel isn't closing
    // return nothing, or throw an error if invalid
    if (exceeds) {
      throw new Error(transfer.id + ' exceeds max unsecured balance of ', self.maxUnsecured)
    }
  },

  createOutgoingClaim: async function (ctx, outgoingBalance) {
    // generate claim for amount
    const self = ctx.state
    const encodedClaim = encodeClaim(outgoingBalance, self.outgoingPaymentChannelId)

    // sign a claim
    const signature = nacl.sign.detached(encodedClaim, self.keyPair.secretKey)
    // const isValid = nacl.sign.detached.verify(encodedClaim, signature, self.keyPair.publicKey)
    console.log('isValid', Buffer.from(self.keyPair.publicKey).toString('hex').toUpperCase())

    // issue a fund tx if required
    //   tell peer about fund tx

    // return claim+amount
    return {
      amount: outgoingBalance,
      signature: Buffer.from(signature).toString('hex')
    }
  },

  handleIncomingClaim: async function (ctx, claim) {
    // get claim+amount
    const self = ctx.state
    const { amount, signature } = claim
    const encodedClaim = encodeClaim(amount, self.incomingPaymentChannelId)

    // validate claim

    const verified = nacl.sign.detached.verify(
      encodedClaim,
      Buffer.from(signature, 'hex'),
      Buffer.from(self.incomingPaymentChannel.publicKey.substring(2), 'hex')
    )

    // TODO: better reconciliation if claims are invalid
    if (!verified) {
      debug('got invalid claim signature', signature, 'for amount', amount)
      throw new Error('got invalid claim signature ' + signature + ' for amount ' + amount)
    }

    // validate claim against balance
    console.log(self.incomingPaymentChannel)
    // TODO: @sharafian, shouldn't amount be compared to incomingPaymentChannel.amount?
    // if (new BigNumber(amount).gt(self.incomingPaymentChannel.balance)) {
    if (new BigNumber(amount).gt(self.incomingPaymentChannel.amount)) {
      debug('got claim for higher amount', amount,
        // 'than channel balance', self.incomingPaymentChannel.balance)
        'than channel balance', self.incomingPaymentChannel.amount)
      throw new Error('got claim for higher amount ' + amount +
        // ' than channel balance ' + self.incomingPaymentChannel.balance)
        ' than channel balance ' + self.incomingPaymentChannel.amount)
    }

    // issue claim tx if required
    // store in max value tracker, throw error if invalid
    await self.incomingClaim.setIfMax({
      value: amount,
      data: signature
    })
  }
})
