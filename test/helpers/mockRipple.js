const WebSocket = require('ws')
const debug = require('debug')('ilp-mock-ripple')

module.exports = function startMockRipple () {
  const wss = new WebSocket.Server({ port: 13415 })
  const messages = [
    // {"command":"subscribe","streams":["ledger"],"id":1}
    '{"id":1,"result":{"fee_base":10,"fee_ref":10,"ledger_hash":"A020BE5817CD89D97F26B614B405CAA888AB7D7F9F5817AF325822CD7AD0D435","ledger_index":423760,"ledger_time":552758411,"reserve_base":20000000,"reserve_inc":5000000,"validated_ledgers":"413738-423760"},"status":"success","type":"response"}',
    // {"command":"subscribe","accounts":["rEWmwfi1BPBzrXZtByyUZw7gbUHRCAxRSF"],"id":2}
    '{"id":2,"result":{},"status":"success","type":"response"}',
    // {"command":"server_info","id":3}
    '{"id":3,"result":{"info":{"build_version":"0.70.1","complete_ledgers":"413738-423781","hostid":"STAB","io_latency_ms":1,"last_close":{"converge_time_s":2,"proposers":4},"load_factor":1,"peers":4,"pubkey_node":"n9MoK5koc8BiPZAzdxCsgheZPCci35JYtJXTRXGzxyfqd3iugjy9","server_state":"proposing","state_accounting":{"connected":{"duration_us":"7018805","transitions":1},"disconnected":{"duration_us":"1189873","transitions":1},"full":{"duration_us":"174461508713","transitions":1},"syncing":{"duration_us":"0","transitions":0},"tracking":{"duration_us":"0","transitions":0}},"uptime":174470,"validated_ledger":{"age":4,"base_fee_xrp":1e-05,"hash":"0D3474DE478A3D222E25836E12F3EBCCF3DD3FF4745F7105B03DD974FF830EA5","reserve_base_xrp":20,"reserve_inc_xrp":5,"seq":423781},"validation_quorum":4}},"status":"success","type":"response"}',
    // {"command":"account_info","account":"rEWmwfi1BPBzrXZtByyUZw7gbUHRCAxRSF","id":4}
    '{"id":4,"result":{"account_data":{"Account":"rEWmwfi1BPBzrXZtByyUZw7gbUHRCAxRSF","Balance":"10000000000","Flags":0,"LedgerEntryType":"AccountRoot","OwnerCount":0,"PreviousTxnID":"3A1C2E7D9402CF4D3C4EFCF0D4ECBB6ABEB24876DCB0A5AB8A6E7DD3FB321FC4","PreviousTxnLgrSeq":419073,"Sequence":1,"index":"C157B22FB349504266366D08B3A6F9097A8CDBF1DA1D00555DED7E15CEF539AB"},"ledger_current_index":423813,"validated":false},"status":"success","type":"response"}'
  ]

  let n = 0
  wss.on('connection', function connection (ws) {
    ws.on('message', function incoming (message) {
      debug('received:', message)
      ws.send(messages[n++])
    })
  })
}
