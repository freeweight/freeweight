// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Read-only sell probe. Never deployed: its runtime code is injected through an eth_call state override, either
/// at a fresh random address (round trip: buy with native ETH, then sell everything back) or at a real holder's address
/// (sell only). Nothing is signed or sent.
///
/// Round-trip stages: 0 = bought and sold, 1 = buy reverted, 2 = token transfer into the pool failed on the sell,
/// 3 = sell swap reverted, 4 = pool unreadable, 5 = zero output, 6 = funding (wrapping ETH) failed.
/// Sell-only stages: 0 = sold, 1 = token transfer into the pool failed, 2 = pool swap reverted, 3 = pool unreadable,
/// 4 = zero output.
contract SellProbe {
    address private _t0; // v3 callback: pool token0
    address private _t1; // v3 callback: pool token1

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    uint160 private constant MIN_SQRT = 4295128740;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    receive() external payable {}

    // ------------------------------------------------------------------ helpers

    function _bal(address token, address who) private view returns (uint256) {
        if (token == address(0)) return who.balance;
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && r.length >= 32 ? abi.decode(r, (uint256)) : 0;
    }

    function _send(address token, address to, uint256 amount) private returns (bool ok, bytes memory r) {
        (ok, r) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (ok && r.length >= 32 && !abi.decode(r, (bool))) ok = false;
    }

    function _bubble(bytes memory r) private pure {
        assembly {
            revert(add(r, 32), mload(r))
        }
    }

    function _wrap(address weth, uint256 amount) private returns (bool ok, bytes memory r) {
        (ok, r) = weth.call{value: amount}(abi.encodeWithSignature("deposit()"));
    }

    // ------------------------------------------------------------------ Uniswap v2 style

    function _swapV2(address tokenIn, address pair, uint256 amount, address tokenOut)
        private
        returns (uint8 stage, uint256 received, uint256 out, bytes memory reason)
    {
        (bool ok, bytes memory r) = pair.staticcall(abi.encodeWithSignature("token0()"));
        if (!ok || r.length < 32) return (3, 0, 0, r);
        bool inIs0 = abi.decode(r, (address)) == tokenIn;
        (ok, r) = pair.staticcall(abi.encodeWithSignature("getReserves()"));
        if (!ok || r.length < 64) return (3, 0, 0, r);
        (uint256 r0, uint256 r1) = abi.decode(r, (uint256, uint256));
        uint256 before = _bal(tokenIn, pair);
        (ok, r) = _send(tokenIn, pair, amount);
        if (!ok) return (1, 0, 0, r);
        uint256 afterBal = _bal(tokenIn, pair);
        received = afterBal > before ? afterBal - before : 0;
        uint256 rIn = inIs0 ? r0 : r1;
        uint256 rOut = inIs0 ? r1 : r0;
        uint256 amountIn = afterBal > rIn ? afterBal - rIn : 0;
        uint256 quoted = (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
        if (quoted == 0) return (4, received, 0, "");
        uint256 outBefore = _bal(tokenOut, address(this));
        (ok, r) = pair.call(
            abi.encodeWithSignature("swap(uint256,uint256,address,bytes)", inIs0 ? 0 : quoted, inIs0 ? quoted : 0, address(this), new bytes(0))
        );
        if (!ok) return (2, received, quoted, r);
        out = _bal(tokenOut, address(this)) - outBefore;
        return (0, received, out, "");
    }

    /// Sell-only from a holder: (stage, received by pool, output, reason).
    function probeV2(address token, address pair, uint256 amount)
        external
        returns (uint8 stage, uint256 received, uint256 out, bytes memory reason)
    {
        (bool ok, bytes memory r) = pair.staticcall(abi.encodeWithSignature("token0()"));
        if (!ok || r.length < 32) return (3, 0, 0, r);
        address t0 = abi.decode(r, (address));
        (ok, r) = pair.staticcall(abi.encodeWithSignature("token1()"));
        if (!ok || r.length < 32) return (3, 0, 0, r);
        address other = t0 == token ? abi.decode(r, (address)) : t0;
        return _swapV2(token, pair, amount, other);
    }

    /// Round trip from a fresh address: wrap qIn ETH, buy the token, sell everything bought.
    function roundTripV2(address token, address weth, address pair, uint256 qIn)
        external
        returns (uint8 stage, uint256 bought, uint256 qOut, bytes memory reason)
    {
        (bool ok, bytes memory r) = _wrap(weth, qIn);
        if (!ok) return (6, 0, 0, r);
        uint256 tBefore = _bal(token, address(this));
        uint8 s;
        (s,,, r) = _swapV2(weth, pair, qIn, token);
        if (s != 0) return (s == 3 ? 4 : 1, 0, 0, r);
        bought = _bal(token, address(this)) - tBefore;
        if (bought == 0) return (1, 0, 0, "");
        uint256 q;
        (s,, q, r) = _swapV2(token, pair, bought, weth);
        if (s == 1) return (2, bought, 0, r);
        if (s == 2) return (3, bought, 0, r);
        if (s != 0) return (5, bought, 0, r);
        return (0, bought, q, "");
    }

    // ------------------------------------------------------------------ Uniswap v3 style

    function _swapV3(address pool, address tokenIn, uint256 amount) private returns (bool ok, int256 a0, int256 a1, bytes memory r) {
        (ok, r) = pool.staticcall(abi.encodeWithSignature("token0()"));
        if (!ok || r.length < 32) return (false, 0, 0, r);
        _t0 = abi.decode(r, (address));
        (ok, r) = pool.staticcall(abi.encodeWithSignature("token1()"));
        if (!ok || r.length < 32) return (false, 0, 0, r);
        _t1 = abi.decode(r, (address));
        bool zeroForOne = _t0 == tokenIn;
        (ok, r) = pool.call(
            abi.encodeWithSignature(
                "swap(address,bool,int256,uint160,bytes)", address(this), zeroForOne, int256(amount), zeroForOne ? MIN_SQRT : MAX_SQRT, new bytes(0)
            )
        );
        if (!ok) return (false, 0, 0, r);
        (a0, a1) = abi.decode(r, (int256, int256));
    }

    function probeV3(address token, address pool, uint256 amount)
        external
        returns (uint8 stage, uint256 received, uint256 out, bytes memory reason)
    {
        (bool ok, int256 a0, int256 a1, bytes memory r) = _swapV3(pool, token, amount);
        if (!ok) return (r.length == 0 ? 3 : 2, 0, 0, r);
        bool zeroForOne = _t0 == token;
        int256 o = zeroForOne ? a1 : a0;
        int256 i = zeroForOne ? a0 : a1;
        return (0, i > 0 ? uint256(i) : 0, o < 0 ? uint256(-o) : 0, "");
    }

    function roundTripV3(address token, address weth, address pool, uint256 qIn)
        external
        returns (uint8 stage, uint256 bought, uint256 qOut, bytes memory reason)
    {
        (bool ok, bytes memory r) = _wrap(weth, qIn);
        if (!ok) return (6, 0, 0, r);
        uint256 tBefore = _bal(token, address(this));
        (ok,,, r) = _swapV3(pool, weth, qIn);
        if (!ok) return (1, 0, 0, r);
        bought = _bal(token, address(this)) - tBefore;
        if (bought == 0) return (1, 0, 0, "");
        uint256 wBefore = _bal(weth, address(this));
        (ok,,, r) = _swapV3(pool, token, bought);
        if (!ok) return (3, bought, 0, r);
        qOut = _bal(weth, address(this)) - wBefore;
        return (qOut == 0 ? 5 : 0, bought, qOut, "");
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _pay(a0, a1);
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _pay(a0, a1);
    }

    function _pay(int256 a0, int256 a1) private {
        (address t, uint256 amt) = a0 > 0 ? (_t0, uint256(a0)) : (_t1, uint256(a1));
        (bool ok, bytes memory r) = _send(t, msg.sender, amt);
        if (!ok) _bubble(r);
    }

    // ------------------------------------------------------------------ Uniswap v4

    /// Sell-only from a holder through PoolManager.unlock; hooks run as in a real sale.
    function probeV4(address token, address manager, PoolKey calldata key, uint256 amount)
        external
        returns (uint8 stage, uint256 received, uint256 out, bytes memory reason)
    {
        (bool ok, bytes memory r) = manager.call(abi.encodeWithSignature("unlock(bytes)", abi.encode(key, token, amount, false)));
        if (!ok) return (2, 0, 0, r);
        (uint256 paid, uint256 got) = abi.decode(abi.decode(r, (bytes)), (uint256, uint256));
        return (got == 0 ? 4 : 0, paid, got, "");
    }

    /// Round trip from a fresh address: buy with `quote` (address(0) = native ETH, else wrapped first), sell back.
    /// preTransfer = false: the tokens stay in the selling wallet until the swap has run and are paid at settlement.
    /// preTransfer = true: the tokens are moved to the PoolManager and settled first, then swapped against that credit
    /// (the order many bots and aggregators use).
    function roundTripV4(address token, address quote, address manager, PoolKey calldata key, uint256 qIn, bool preTransfer)
        external
        returns (uint8 stage, uint256 bought, uint256 qOut, bytes memory reason)
    {
        bool ok;
        bytes memory r;
        if (quote != address(0)) {
            (ok, r) = _wrap(quote, qIn);
            if (!ok) return (6, 0, 0, r);
        }
        (ok, r) = manager.call(abi.encodeWithSignature("unlock(bytes)", abi.encode(key, quote, qIn, false)));
        if (!ok) return (1, 0, 0, r);
        (, bought) = abi.decode(abi.decode(r, (bytes)), (uint256, uint256));
        if (bought == 0) return (1, 0, 0, "");
        // Sell what actually arrived (a transfer tax on the way out of the pool lowers it).
        uint256 have = _bal(token, address(this));
        if (have < bought) bought = have;
        (ok, r) = manager.call(abi.encodeWithSignature("unlock(bytes)", abi.encode(key, token, bought, preTransfer)));
        if (!ok) return (3, bought, 0, r);
        (, qOut) = abi.decode(abi.decode(r, (bytes)), (uint256, uint256));
        return (qOut == 0 ? 5 : 0, bought, qOut, "");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, address inC, uint256 amount, bool pre) = abi.decode(data, (PoolKey, address, uint256, bool));
        bool zeroForOne = key.currency0 == inC;
        bool ok;
        bytes memory r;
        uint256 prepaid;
        if (pre && inC != address(0)) {
            // Move the tokens out of the wallet and into the PoolManager before swapping; swap what was credited.
            (ok, r) = msg.sender.call(abi.encodeWithSignature("sync(address)", inC));
            if (!ok) _bubble(r);
            (ok, r) = _send(inC, msg.sender, amount);
            if (!ok) _bubble(r);
            (ok, r) = msg.sender.call(abi.encodeWithSignature("settle()"));
            if (!ok) _bubble(r);
            prepaid = abi.decode(r, (uint256));
            amount = prepaid;
        }
        (ok, r) = msg.sender.call(
            abi.encodeWithSignature(
                "swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)",
                key,
                SwapParams(zeroForOne, -int256(amount), zeroForOne ? MIN_SQRT : MAX_SQRT),
                new bytes(0)
            )
        );
        if (!ok) _bubble(r);
        int256 delta = abi.decode(r, (int256));
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        int128 owe = zeroForOne ? a0 : a1;
        int128 get = zeroForOne ? a1 : a0;
        uint256 pay = owe < 0 ? uint256(uint128(-owe)) : 0;
        uint256 take = get > 0 ? uint256(uint128(get)) : 0;
        if (prepaid > 0) pay = pay > prepaid ? pay - prepaid : 0; // already settled up front
        if (pay > 0) {
            if (inC == address(0)) {
                (ok, r) = msg.sender.call{value: pay}(abi.encodeWithSignature("settle()"));
                if (!ok) _bubble(r);
            } else {
                (ok, r) = msg.sender.call(abi.encodeWithSignature("sync(address)", inC));
                if (!ok) _bubble(r);
                (ok, r) = _send(inC, msg.sender, pay);
                if (!ok) _bubble(r);
                (ok, r) = msg.sender.call(abi.encodeWithSignature("settle()"));
                if (!ok) _bubble(r);
            }
        }
        if (take > 0) {
            address outC = zeroForOne ? key.currency1 : key.currency0;
            (ok, r) = msg.sender.call(abi.encodeWithSignature("take(address,address,uint256)", outC, address(this), take));
            if (!ok) _bubble(r);
        }
        return abi.encode(prepaid > 0 ? prepaid : pay, take);
    }
}
