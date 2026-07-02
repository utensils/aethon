// Prevents an extra console window on Windows in release; harmless
// elsewhere. The desktop entry (bin) just calls the lib's run().
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aethon_mobile_lib::run();
}
