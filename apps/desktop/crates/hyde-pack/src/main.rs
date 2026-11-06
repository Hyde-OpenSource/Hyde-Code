use clap::Parser;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "hyde-pack",
    about = "Compile Hyde AI TOML data into a deterministic pack"
)]
struct Args {
    /// Directory containing intents/ and optionally apps.toml.
    source: PathBuf,
    /// Output .pack path.
    output: PathBuf,
}

fn main() {
    let args = Args::parse();
    match hyde_pack::compile_to_file(&args.source, &args.output) {
        Ok(size) => println!("wrote {} ({} bytes)", args.output.display(), size),
        Err(error) => {
            eprintln!("hyde-pack: {error}");
            std::process::exit(2);
        }
    }
}
