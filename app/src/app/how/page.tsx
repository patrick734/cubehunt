export const metadata = { title: "How CubeHunt works" };

export default function HowPage() {
  return (
    <div className="wrap page prose">
      <div className="page-head">
        <div>
          <span className="eyebrow">How it works</span>
          <h1>The chain checks the cubes</h1>
        </div>
      </div>

      <section className="card">
        <h2>The problem</h2>
        <p>
          Which whole numbers k can be written as x³ + y³ + z³ with whole numbers x, y, z (negatives allowed)? Numbers that leave 4 or 5 after dividing by 9
          never can. For the rest, mathematicians expect an answer exists, but finding one can take enormous searches: 33 and 42 were only solved in 2019,
          by Andrew Booker and Andrew Sutherland, with z in the quadrillions. Below 1000, seven are still open: 114, 390, 627, 633, 732, 921 and 975.
        </p>
      </section>

      <section className="card">
        <h2>What your browser does</h2>
        <p>
          Write d = x + y. Then k − z³ = d·(x² − xy + y²), so d must divide k − z³. Your browser picks a prime p with p ≡ 2 (mod 3), where every number
          has exactly one cube root, takes z ≡ ∛k (mod p) somewhere in the band 10^20 ≤ |z| &lt; 10^21, and sets d = ±p. Then it checks whether
          Δ = (4(k − z³)/d − d²)/3 could be a perfect square, using nine fast tests (mod 64, 7, 11, 13, 17, 19, 23, 29, 31). If Δ really is a square r²,
          then x = (d + r)/2 and y = (d − r)/2 solve the problem.
        </p>
        <p>
          A candidate that passes all nine tests and whose hash with your address meets the season&apos;s difficulty is a <b>share</b>. Shares prove work
          was done in the right place; the contract re-runs every check before it counts one.
        </p>
      </section>

      <section className="card">
        <h2>Points, prizes and the DAO</h2>
        <ul>
          <li>Each accepted share earns points. Funding a prize vault earns points too (USDG at $1; ETH at its Chainlink price when the DAO has set one).</li>
          <li>Points are votes in the CubeHunt DAO. They can&apos;t be transferred or sold, and nobody can print them: the guardian can&apos;t set prices or minters.</li>
          <li>Each target has a prize vault. Only the hunt contract can pay it, only to a solution the chain verified, through commit-then-reveal so nobody can copy your answer.</li>
          <li>Vault money is otherwise controlled by DAO votes, which wait 48 hours in a public timelock before anyone can execute them.</li>
        </ul>
      </section>

      <section className="card">
        <h2>$CUBE</h2>
        <p>
          A small ETH fee on each accepted share, and a small fee on each vault deposit, go to the BuyBurn contract. A keeper uses them to buy $CUBE on
          its Pons pool and burn it. The BuyBurn has no withdrawal function. Fees are capped in code and only a DAO vote can change them.
        </p>
      </section>

    </div>
  );
}
