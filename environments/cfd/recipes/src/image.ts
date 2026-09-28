import { OPENFOAM_IMAGE } from "@beam/contracts";

/** The image a recipe runs in, as its report records it: the cfd environment's, from BEAM_IMAGE, or OpenFOAM's own. */
export const recipeImage = () => process.env["BEAM_IMAGE"] ?? OPENFOAM_IMAGE;
