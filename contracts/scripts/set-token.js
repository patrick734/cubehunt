// Plugs $CUBE into the BuyBurn after its Pons launch. One transaction from the dev wallet (the one-time token
// setter), permanent: nobody can change it afterwards.
//   CUBE_TOKEN_ADDRESS=0x... node ../tools/with-key.js <wallet> -- npx hardhat run scripts/set-token.js --network robinhood
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", "robinhood.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const token = process.env.CUBE_TOKEN_ADDRESS;
  if (!token || !ethers.isAddress(token)) throw new Error("CUBE_TOKEN_ADDRESS is not a valid address");
  const [me] = await ethers.getSigners();
  const t = new ethers.Contract(token, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function burn(uint256)"], me);
  const [sym, dec] = await Promise.all([t.symbol(), t.decimals()]);
  if (dec !== 18n) throw new Error(`token has ${dec} decimals, expected 18`);
  await t.burn.staticCall(0).catch(() => {
    throw new Error("token has no burn(uint256); BuyBurn needs it");
  });
  const bb = await ethers.getContractAt("CubeBuyBurn", d.buyBurn, me);
  const cur = await bb.token();
  if (cur !== ethers.ZeroAddress) {
    console.log(`BuyBurn already burns ${cur}. Nothing to do.`);
  } else {
    if ((await bb.tokenSetter()).toLowerCase() !== me.address.toLowerCase()) throw new Error(`${me.address} is not the token setter`);
    const tx = await bb.setToken(token);
    console.log(`setToken(${token}) ${sym}: ${tx.hash}`);
    await tx.wait();
  }
  d.cube = token;
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  console.log("Saved to deployments/robinhood.json. BuyBurn now buys and burns", sym);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
