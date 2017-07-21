'use strict'

const nock = require('nock')
const Store = require('./helpers/store')
const mockRipple = require('./helpers/mockRipple')
const assert = require('chai').assert
const Plugin = require('..')

mockRipple()
describe('PluginXrpPaychan', () => {
  beforeEach(function () {
    this.opts = {
      maxInFlight: '3000000',
      maxBalance: '9000000',
      channelAmount: '9000000',
      server: 'ws://localhost:13415',
      secret: 'snFCsq4xhtXPxsP89agNdRJ2H8xkp',
      channelSecret: 'secret',
      address: 'rEWmwfi1BPBzrXZtByyUZw7gbUHRCAxRSF',
      // peer secret: snU7Gy4GUJ2XCLL4CfhbpwmGv92eC
      peerAddress: 'rhQihkEUYLCxVWhundtamge4uVZNPdxi7F',
      _store: new Store(),
      rpcUri: 'https://example.com/rpc'
    }

    this.plugin = new Plugin(this.opts)
  })

  it('should create a plugin', async function () {
    await this.plugin.connect()
  })
})
