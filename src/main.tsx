import { applyBootTheme } from "./themeBootstrap";
import { bootMark } from "./utils/bootTrace";

bootMark("main-eval");
applyBootTheme();
void import("./mainApp");
