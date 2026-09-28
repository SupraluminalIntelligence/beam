/** Study recipes: what the cfd environment's beam-recipe runs, and the pure parts Beam's tools reuse. */
export { planarMesh, planarFiles } from "./planar.ts";
export { channelFiles, foamShell, foamValues, residualHistory, runRecipe, type FoamShell } from "./openfoam.ts";
export { exportOpenFoam } from "./openfoam.ts";
export { writeStudyResults } from "./results.ts";
export { domain3dFiles, domain3dSolveCommands, parseVtkSurface, readDat, streamlineSeeds, triangulateFaces, safeMeshEntries, sliceOffset, domain3dProcesses, writeModelSurfaces } from "./domain3d.ts";
