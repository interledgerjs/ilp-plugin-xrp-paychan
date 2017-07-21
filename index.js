'use strict'

const { makePaymentChannelPlugin } = require('ilp-plugin-payment-channel-framework')
const PluginXrpPaychan = require('./src/plugin.js')

module.exports = makePaymentChannelPlugin(PluginXrpPaychan)
