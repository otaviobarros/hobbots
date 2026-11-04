import type { PixelPalette, PixelRows } from "@hobbots/ui/components/pixel-art";

/**
 * The night village behind Home, from the design's Home screen: hills and trees, houses with lit
 * windows, a lamp post, a fence and the lane the hobs stand in. 160 × 31 cells; the scene crops it
 * from the bottom, so the lane always shows.
 */
export const HOME_VILLAGE: PixelRows = [
  "hhhpphhhhhhhhhhhhhhhhhhrrvhhhhttktttthhhnnnhhhnnnhhhhhhhhnnnhhhhhhhhhhhhhhhhhhhhhhphhhhhhhhhhhhhhnnnnnhhhhnnnhhnnnhhhhhhvhhhhhhhvvvhhhpppphhhhhhhhhhhhhhhhhhhhhh",
  "hhhhhhhhhhhhhhnhhhhhhhhrrvhhhhttttttthhhnnnhhhnnnhhhhhhhnnnnnhhhhhhhhhhhhhhhhhhhhhhhhhhyyyyhhhhhhhnnnhhhhnnnnnhnnnhhhhhvvvhhhhhhvvvhhhhphhhhhhhhhhhhhhhhhhhhhhhh",
  "hhhhhhhhhhhhhnnnhhhhhhvrrvvgggttttttthhnnnnnhnnnnnhhhhhhhnnnhhhhhhhhhhhhhhhhhhhhhhhhhhyyyyyyvhhhhnnnnnhhhhnnnhnnnnnhhhhvvvhhhhhvvvvvhhhhhhhhhhrrhhhhhhhhhhhhhhhh",
  "hhhhhhhrrrrrrrrrrrrrrrrrrgggggttttttthhhnnnhhhnnnhhhhhhhnnnnnhhhhhhhhhhhhhhhhhhhhhhhhhttttttvvhhnnnnnnnhhnnnnnhnnnhhhhvvvvvggggggvggghhhhhhhhyrryyhhhhhhhhhnhhhh",
  "hhhhhhrrrrrrrrrrrrrrrrrrrrggggtttttttghnnnnnhnnnnnhhhhhnnnnnnnhhhqqqhhhhhhhhhhhhhhhhhhttktttvvhhhhgnghhhnnnnnnnnnnnhhhhgvgggggggggggggghhhhhyyrryyyhhhnhhhnnnhhh",
  "hhhhhrrrrrrrrrrrrrrrrrrrrrrgggggggggggnnnnrrnnnnnnnhhgggggngghhhhqlqhhhhhhhhhhhhhhhhhhttttttvvvggggggggggggnhnnnnnnnggggggggggggrrrrrrrrrrrrrrrrttthhnnnhhnnnhhh",
  "hhhhrrrrrrrrrrrrrrrrrrrrrrrrgggggggggggggnrrgggngggggggggggggggghqqqhhhhhhhhhhhhhhhhhhttttttvgggggggggggggggggggnggggggggggggggrrrrrrrrrrrrrrrrrrtthhnnnhnnnnnhh",
  "hhhrrrrrrrrrrrrrrrrrrrrrrrrrrgggggggggggggrrggggggggggggggggggggvvqvvhhhhhhhhhhhhhhhhhttttttggggggggggggggggggggggggggggggggggrrrrrrrrrrrrrrrrrrrrthnnnnnhnnnhhh",
  "hhheeeeeeeeeeeeeeeeeeeeeeeeeegggggggrrrrrrrrggggggggggggggggggggggqghhhhhhhhhhhhhhhhhhttttttgggggggggggggggggggggggggggggggggrrrrrrrrrrrrrrrrrrrrrrhhnnnhnnnnnhg",
  "gghwwwwwwwwwwwwwwwwwwwwwwwwwwggggggrrrrrrrrrrgggggggggggggggggggggqgggghhhhhhhhhhhhhhgggggggggggggggggggggggggggggggggggggggrrrrrrrrrrrrrrrrrrrrrrrrnnnnnnnnnnng",
  "gggwwwfffffwwfffffwwwwwwwwwwwgggggrrrrrrrrrrrrggggggggggggggggggggqgggggghhhhhhhhhhgggggggggggggggggggggggggggggggggggggggggeeeeeeeeeeeeeeeeeeeeeeeennnnnnrrrrgg",
  "gggwwwflflfwwflflfwwwwwwwwwwwggggrrrrrrrrrrrrrrgggggggggggggggggGGqgggggggggggggggggggggggggggggggggggggggggggggggggggggggggwwwwwwwwwwwwwwwwwwwwwwwwggnggrrrrrrg",
  "gggwwwfffffwwfffffwwwwwwwwwwwgggrrrrrrrrrrrrrrrrgggggggggggggGGGGGqGGGggggggggggggggggggggggggggggggggggggggggggggggggggggggwwwfffffwwfffffwwwwwwwwwggggrrrrrrrr",
  "GGgwwwflflfwwflflfwwwwwwwwwwwgggeeeeeeeeeeeeeeeegggggggggggGGGGGGGqGGGGGGggggggggggGGGGGGgggggggggggggggggggggggggggggggggggwwwflflfwwflflfwwwwwwwwwgggrrrrrrrrr",
  "GGGwwwfffffwwfffffwwwwwwwwwwwgggwwwwwwwwwwwwwwwwgggggggggGGGGGGGGGqGGGGGGGGGGGGGGGGGGGGGGGGgggggggggggggggggggGGGGGGggggggggwwwfffffwwfffffwwwwwwwwwggrrrrrrrrrr",
  "GGGwwwwwwwwwwwwwwwwwwwwwwwwwwgggwwwfffffwwwwwwwwgggggggGGGGGGGGGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGggggggggggggggGGGGGGGGGGGGGGGGGwwwflflfwwflflfwwwwwwwwwgGeeeeeeeeee",
  "GGGwwwwwwwwwwwwwwwwwwwwwwwwwwgggwwwflflfwwwwwwwwGGggGGGGGGGGGGGGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGGGggggggggggGGGGGGGGGGGGGGGGGGGwwwfffffwwfffffwwwwwwwwwGGwwwwwwwwww",
  "GGGwwwwwwwwwwwwwwwwwwwddddwwwGGGwwwfffffwwdddwwwGGGGGGGGGGGGGGGGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGgggggGGGGGGGGGGGGGGGGGGGGGGwwwwwwwwwwwwwwwwwddddwwwGGwwwfffdddw",
  "GGGwwwwwwwwwwwwwwwwwwwddddwwwGGGwwwflflfwwdddwwwGGGGGGGGGGGGGGGGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGwwwwwwwwwwwwwwwwwddddwwwGGwwwflfdddw",
  "GGGwwwwwwwwwwwwwwwwwwwddddwwwGGGwwwfffffwwdddwwwGGqGGqGGqGGqGGqGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGqGGqGGqGGqGGqGGqGGqGGqGGGGwwwwwwwwwwwwwwwwwddddwwwGGwwwfffdddw",
  "GGGwwwwwwwwwwwwwwwwwwwdddkwwwGGGwwwwwwwwwwddkwwwGGqqqqqqqqqqqqqGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGqqqqqqqqqqqqqqqqqqqqqqqGGGwwwwwwwwwwwwwwwwwdddkwwwGGwwwflfddkw",
  "GGGwwwwwwwwwwwwwwwwwwwddddwwwGGGwwwwwwwwwwdddwwwGGqGGqGGqGGqGGqGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGqGGqGGqGGqGGqGGqGGqGGqGGGGwwwwwwwwwwwwwwwwwddddwwwGGwwwfffdddw",
  "GGGwwwwwwwwwwwwwwwwwwwddddwwwGGGwwwwwwwwwwdddwwwGGqGGqGGqGGqGGqGGGqGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGqGGqGGqGGqGGqGGqGGqGGqGGGGwwwwwwwwwwwwwwwwwddddwwwGGwwwwwwdddw",
  "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
  "ccccccccccccsccccccccccccccccccccccccsccccccccccccccccscccccccccccccccsccccAAaaaaaaaAAcccccccccsccccccccccccccscccccccscccccccccccccccccccccsccccccccccccccccscc",
  "cccccccccccccsccccccccccccccccccccccccsccccccccccccccccscccccccccccccccscccAAaaaaaaaaaAAccccccccsccccccccccccccscccccccscccccccccccccccccccccsccccccccccccccccsc",
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccAAaaaaaaaaaAAcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccAAaaaaaaaaaaaAAcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccAAaaaaaaaaaaaAAcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccAAaaaaaaaaaaaaaAAccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccAAaaaaaaaaaaaaaAAccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

/** Night colors in every theme: Home's village stays a night scene in the light themes too. */
export const HOME_VILLAGE_PALETTE: PixelPalette = {
  h: "#1d1939", // the hills behind the village
  p: "#1b1736", // flecks on the hills
  y: "#1c1530", // bushes
  n: "#120f24", // the dark trees
  v: "#18132e", // the pines
  g: "#241e46", // the green between the houses
  G: "#2b2452", // the grass along the lane
  r: "#2a1f3d", // roofs
  e: "#352947", // eaves
  t: "#372c55", // the towers
  w: "#3d2f52", // walls
  f: "#9a5f16", // window frames
  l: "#ffd28a", // lit windows and the lamp
  d: "#231a33", // doors
  k: "#f2a541", // door knobs and the tower windows
  q: "#5b4a6e", // the lamp post and the fence
  o: "#3a3666", // the edge of the lane
  c: "#2c2a5a", // the lane
  s: "#46417a", // stones in the lane
  a: "#3b3772", // the path up to the houses
  A: "#34306a", // the edge of the path
};
