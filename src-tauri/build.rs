fn main() {
    // Rebuild the embedded Windows icon resource when the icons change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
