export const brand = {
  name: "CubeHunt",
  token: "$CUBE",
  ticker: "CUBE",
  site: process.env.NEXT_PUBLIC_SITE_URL || "https://cubehunt.fun",
  x: process.env.NEXT_PUBLIC_X_URL || "",
  tokenAddress: (process.env.NEXT_PUBLIC_CUBE_CA || "") as `0x${string}` | "",
  tagline: "Hunt unsolved sums of three cubes. The chain checks every answer.",
};

export const tradeUrl = (ca: string) => `https://www.ponsfamily.com/launchpad/${ca}`;
