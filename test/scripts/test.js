const BtpPlugin = require('../..')
const IlpPacket = require('ilp-packet')

process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection', e)
})

class Store {
  constructor () {
    this._store = {}
  }

  async get (k) {
    return this._store[k]
  }

  async put (k, v) {
    this._store[k] = v
  }

  async del (k) {
    delete this._store[k]
  }
}

const server = new BtpPlugin({
  listener: {
    port: 9000,
    secret: 'secret'
  },
  rippledServer: 'wss://s.altnet.rippletest.net:51233',
  peerAddress: 'raYsh5o2YXvuZKj6xYyuHNitUTzT8dWKYE',
  secret: 'snUNeZeq4QRqefSh7oydUSWZv1uh3', 
  _store: new Store()
})
const client = new BtpPlugin({
  server: 'btp+ws://:secret@localhost:9000',
  rippledServer: 'wss://s.altnet.rippletest.net:51233',
  peerAddress: 'rW1XrgCvURLdPkdVsQhmWsRqtgMnApepK',
  secret: 'sspGuk1g9KPX4ac8oq9MDsW5QUsQM',
  _store: new Store()
})

async function run () {
  await Promise.all([
    server.connect(),
    client.connect()
  ])

  server.registerDataHandler((ilp) => {
    console.log('server got:', IlpPacket.deserializeIlpPacket(ilp))
    return IlpPacket.serializeIlpFulfill({
      fulfillment: Buffer.alloc(32),
      data: Buffer.from('hello world again')
    })
  })

  const response = await client.sendData(IlpPacket.serializeIlpPrepare({
    amount: '10',
    expiresAt: new Date(),
    executionCondition: Buffer.alloc(32),
    destination: 'peer.example',
    data: Buffer.from('hello world')
  }))

  console.log('client got:', IlpPacket.deserializeIlpPacket(response))

  await server.sendMoney(10)
  await client.sendMoney(10)

  console.log('sent money')
  console.log('testing reconciliation')

  server._incomingClaim = { amount: '0' } // simulate out of sync behavior
  await client.sendMoney(10) // this call should warn about discrepency
  await client.sendMoney(10) // this call should not

  console.log('done; disconnecting')

  await client.disconnect()
  await server.disconnect()
  process.exit(0)
}

run()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
