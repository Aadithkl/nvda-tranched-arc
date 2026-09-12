// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract TestWETH9 {
    string public name = "Wrapped Native (test)";
    string public symbol = "WmNATIVE";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad, "insufficient");
        balanceOf[msg.sender] -= wad;
        (bool ok,) = msg.sender.call{ value: wad }("");
        require(ok, "transfer failed");
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() public view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 wad) public returns (bool) {
        allowance[msg.sender][spender] = wad;
        emit Approval(msg.sender, spender, wad);
        return true;
    }

    function transfer(address to, uint256 wad) public returns (bool) {
        return _transfer(msg.sender, to, wad);
    }

    function transferFrom(address from, address to, uint256 wad) public returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= wad, "insufficient allowance");
            allowance[from][msg.sender] = allowed - wad;
        }
        return _transfer(from, to, wad);
    }

    function _transfer(address from, address to, uint256 wad) internal returns (bool) {
        require(balanceOf[from] >= wad, "insufficient balance");
        balanceOf[from] -= wad;
        balanceOf[to] += wad;
        emit Transfer(from, to, wad);
        return true;
    }
}
