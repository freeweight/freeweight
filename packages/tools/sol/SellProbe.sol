// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Read-only sell probe. Never deployed: its runtime code is injected at a real holder's address through an
/// eth_call state override, so the token sees a normal holder selling into the pool. Nothing is signed or sent.
/// Return: stage 0 = sold, 1 = token transfer into pool failed, 2 = pool swap reverted, 3 = pool unreadable, 4 = zero out.
contract SellProbe {
    address private _token;

    function _bal(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && r.length >= 32 ? abi.decode(r, (uint256)) : 0;
    }

    function _send(address token, address to, uint256 amount) private returns (bool ok, bytes memory r) {
        (ok, r) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (ok && r.length >= 32 && !abi.decode(r, (bool))) ok = false;
    }

    function probeV2(address token, address pair, uint256 amount)
        external
        returns (uint8 stage, uint256 received, uint256 out, bytes memory reason)
    {
        (bool ok, bytes memory r) = pair.staticcall(abi.encodeWithSignature("token0()"));
        if (!ok || r.length < 32) return (3, 0, 0, r);
        bool isT0 = abi.decode(r, (address)) == token;
        (ok, r) = pair.staticcall(abi.encodeWithSignature("getReserves()"));
        if (!ok || r.length < 64) return (3, 0, 0, r);
        (uint256 r0, uint256 r1) = abi.decode(r, (uint256, uint256));
        uint256 before = _bal(token, pair);
        (ok, r) = _send(token, pair, amount);
        if (!ok) return (1, 0, 0, r);
        uint256 afterBal = _bal(token, pair);
        received = afterBal > before ? afterBal - before : 0;
        uint256 rIn = isT0 ? r0 : r1;
        uint256 rOut = isT0 ? r1 : r0;
        uint256 amountIn = afterBal > rIn ? afterBal - rIn : 0;
        out = (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
        if (out == 0) return (4, received, 0, "");
        (ok, r) = pair.call(
            abi.encodeWithSignature("swap(uint256,uint256,address,bytes)", isT0 ? 0 : out, isT0 ? out : 0, address(this), new bytes(0))
        );
        if (!ok) return (2, received, out, r);
        return (0, received, out, "");
    }

    function probeV3(address token, address pool, uint256 amount)
        external
        returns (uint8 stage, uint256 received, uint256 out, bytes memory reason)
    {
        (bool ok, bytes memory r) = pool.staticcall(abi.encodeWithSignature("token0()"));
        if (!ok || r.length < 32) return (3, 0, 0, r);
        bool zeroForOne = abi.decode(r, (address)) == token;
        _token = token;
        uint160 limit = zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341;
        (ok, r) = pool.call(
            abi.encodeWithSignature("swap(address,bool,int256,uint160,bytes)", address(this), zeroForOne, int256(amount), limit, new bytes(0))
        );
        if (!ok) return (2, 0, 0, r);
        (int256 a0, int256 a1) = abi.decode(r, (int256, int256));
        int256 o = zeroForOne ? a1 : a0;
        int256 i = zeroForOne ? a0 : a1;
        return (0, i > 0 ? uint256(i) : 0, o < 0 ? uint256(-o) : 0, "");
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _pay(a0, a1);
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _pay(a0, a1);
    }

    function _pay(int256 a0, int256 a1) private {
        uint256 amt = uint256(a0 > 0 ? a0 : a1);
        (bool ok, bytes memory r) = _send(_token, msg.sender, amt);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }
}
