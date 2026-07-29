/**
 * Hearth, over both of its listeners.
 *
 * The node runs **two** HTTP servers in one process: the REST API on 8645 and the Ethereum
 * JSON-RPC on 8545. The split matters because the JSON-RPC listener fails soft — `listenJsonRpc`
 * logs and returns — while `/info` keeps advertising `jsonRpc: ":8545/"` from the configured port
 * whether or not anything ever bound it, and the compose healthcheck only asks 8645. So a node
 * with no JSON-RPC at all reports healthy, and 8545 is the port that carries money: forge-pay's
 * deposit watcher speaks `eth_*` to it, and that is how an EMBER deposit becomes Shards.
 *
 * **`eth_chainId` is the one value in this whole corpus that is normalised out of the way of
 * itself.** It is a hex quantity like every block height, and the `hex-quantity` rule would erase
 * it, so this scenario switches that rule off by name for that one call. The value must read
 * `0x1cf4` — 7412 — on this testnet: `params.js` refuses to start on an unknown network but takes
 * an explicitly set `HEARTH_CHAIN_ID` at its word, so a wrong-but-valid id misroutes nothing and
 * stays invisible, while removing the only thing EIP-155 gives us. At 7411 every hearth-testnet
 * transaction becomes replayable on hearth mainnet and back.
 *
 * `eth_getBalance` is asked about the zero address, deliberately: it is the commons address, it
 * exists on every deployment, and no key anywhere can spend from it.
 */

import { defineScenario } from '../scenario.ts'

/** The commons address. Reading it moves nothing and needs no funded account. */
const COMMONS_ADDRESS = '0x0000000000000000000000000000000000000000'

const rpc = (id: number, method: string, params: readonly unknown[] = []) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})

export default defineScenario({
  name: 'chain',
  title: 'The node answers on both listeners, on the expected chain, at a height that is a number',
  description:
    'A difference here means deposits stop crediting: the deposit watcher polls eth_blockNumber and reads balances over ' +
    'this port, and a node on the wrong chain id makes every signature bound to somebody else’s network.',
  targets: ['hearth-rpc', 'hearth-rest'],
  async run(ctx) {
    await ctx.call('the chain id is the testnet chain id', {
      target: 'hearth-rpc',
      method: 'POST',
      path: '/',
      body: rpc(1, 'eth_chainId'),
      // The whole point of this call. See the file header.
      exclude: ['hex-quantity'],
    })

    await ctx.call('net_version answers in decimal, not hex', {
      target: 'hearth-rpc',
      method: 'POST',
      path: '/',
      body: rpc(2, 'net_version'),
      // `net_version` is the one place in the surface where hex is wrong, and getting the pair
      // backwards is what makes a wallet refuse the network outright. Its value is the chain id in
      // decimal, so like `eth_chainId` it is contract rather than gauge. `decimal-string` does not
      // fire on `"7412"` today because it wants six digits or more — the exclusion is here so that
      // a six-digit chain id does not silently erase the assertion later.
      exclude: ['decimal-string'],
    })

    await ctx.call('the block number reads back as a hex quantity', {
      target: 'hearth-rpc',
      method: 'POST',
      path: '/',
      body: rpc(3, 'eth_blockNumber'),
    })

    await ctx.call('a balance can be read', {
      target: 'hearth-rpc',
      method: 'POST',
      path: '/',
      body: rpc(4, 'eth_getBalance', [COMMONS_ADDRESS, 'latest']),
    })

    await ctx.call('an unknown method is refused with a JSON-RPC error', {
      target: 'hearth-rpc',
      method: 'POST',
      path: '/',
      body: rpc(5, 'eth_thisMethodDoesNotExist'),
    })

    await ctx.call('the REST listener reports the chain', {
      target: 'hearth-rest',
      path: '/info',
      // The genesis hash identifies the chain and must stay comparable; the tip beside it is
      // normalised by the field-name rule instead. A replacement pointed at a different chain has
      // a different genesis, and that is exactly the difference this corpus exists to surface.
      exclude: ['hash-32'],
    })

    await ctx.call('emission accounting reads back', { target: 'hearth-rest', path: '/supply' })
  },
})
