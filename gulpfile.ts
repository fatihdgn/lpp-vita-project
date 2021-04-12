import os from "os";
import gulp from "gulp";
import fs from "fs";
import del from "del";
import { execSync } from "child_process";
import zip from "gulp-zip";
import merge from "merge-stream";
import { src } from "gulp";
import rename from "gulp-rename";
import filter from "gulp-filter";
import { Client } from "basic-ftp";
const pngquant = require("gulp-pngquant");
const NetcatClient = require("netcat/client");

interface IVitaProjectConfiguration {
  id: string;
  title: string;
  ip?: string;
  ports: { ftp: number; cmd: number };
  srcDir: string
  outDir: string;
}

const defaults = {
  projectConfigurationFilePath: "./lpp-vita-project.json",
  ebootFileName: 'eboot.bin',
  indexFileName: 'index.lua',
  tempDir: '.temp',
  config: <IVitaProjectConfiguration>{
    id: 'HELLOWRLD',
    title: "Hello World",
    ports: {
      ftp: 1337,
      cmd: 1338,
    },
    srcDir: "src",
    outDir: "dist",
  }
};

const errors = {
  projectConfigFileIsMissing:
    "vita-project.json file is missing. It's required for the build process.",
  idDoesNotConformRequirements:
    "'id' is not defined or does not conform the requirements. It must be exactly 9 characters long.",
  titleIsNotAvailable: "'title' is not available.",
  srcDirDoesntExists: `Source directory doesn\'t exist. Please create a directory with the name defined inside project file. Default directory name is '${defaults.config.srcDir}'`,
  ebootFileIsMissing:
    `eboot file is missing. Make sure you have the ${defaults.ebootFileName} file at the source directory. Download it from 'https://github.com/Rinnegatamante/lpp-vita/releases/latest' if you don't have it and select which eboot you want to use and add it to the source directory with the name '${defaults.ebootFileName}'.`,
  indexFileIsMissing: `index file is missing. Make sure you have the ${defaults.indexFileName} file at the source directory.`,
  ipIsNotDefined:
    "'ip' is not defined inside project file and not sent from connect call.",
};

// TODO: Find a way to get these Vita Project codes out from the gulpfile.ts

// TODO: Implement a resource file structure to get

async function sleepAsync(ms: number) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

function toPromise(stream: NodeJS.ReadWriteStream) {
  return new Promise((resolve, reject) => {
    stream.on("error", reject).on("end", resolve);
  });
}

class VitaProject {
  constructor(
    configurationFilePath?: string,
    public logger: (message: any) => void = console.log // Verbose?
  ) {
    this.configuration = this.readConfiguration(
      configurationFilePath ?? defaults.projectConfigurationFilePath
    );
    this.validateConfiguration(this.configuration);
    this.checkRequiredFiles();
  }

  configuration: IVitaProjectConfiguration;

  private readConfiguration(filePath: string): IVitaProjectConfiguration {
    this.logger("Reading configuration...");
    if (!fs.existsSync(filePath)) throw errors.projectConfigFileIsMissing;
    let vitaProjectConfig = Object.assign(
      defaults.config,
      JSON.parse(fs.readFileSync(filePath, "utf-8"))
    );
    this.logger("Configuration readed successfully.");
    return vitaProjectConfig;
  }

  private validateConfiguration(configuration: IVitaProjectConfiguration) {
    this.logger("Validating configuration...");
    if (configuration.id == null || configuration.id.length !== 9)
      throw errors.idDoesNotConformRequirements;
    if (configuration.title == null) throw errors.titleIsNotAvailable;

    this.logger("Configuration has no errors.");
  }
  checkRequiredFiles() {
    this.logger("Checking source directory first...");
    if(!fs.existsSync(`${this.configuration.srcDir}/`))
      throw errors.srcDirDoesntExists;
    this.logger("Checking required files");
    if (!fs.existsSync(`${this.configuration.srcDir}/${defaults.ebootFileName}`))
      throw errors.ebootFileIsMissing;
    if (!fs.existsSync(`${this.configuration.srcDir}/${defaults.indexFileName}`))
      throw errors.indexFileIsMissing;
    this.logger("Required files is in place.");
  }

  generateNetcatClient(): typeof NetcatClient {
    if (this.configuration.ip == null) throw errors.ipIsNotDefined;
    return new NetcatClient()
      .addr(this.configuration.ip)
      .port(this.configuration.ports?.cmd ?? defaults.config.ports?.cmd ?? 1338)
      .retry(5000);
  }

  sendCmdAsync(cmd: string) {
    return new Promise<void>((resolve, reject) => {
      let nc: typeof NetcatClient;
      try {
        nc = this.generateNetcatClient();
      } catch (error) {
        reject(error);
      }
      nc.on("error", reject)
        .connect()
        .send(cmd + "\n", () => {
          nc.close(() => {
            resolve();
          });
        });
    });
  }

  async clearTempDirectoryAsync() {
    this.logger("Clearing temp directory...");
    await del(defaults.tempDir);
    this.logger("Temp directory cleared.");
  }

  generateSfoFile(path: string) {
    this.logger(`Generating sfo file to path: ${path}`);
    execSync(
      `vita-mksfoex -s TITLE_ID=${this.configuration.id} "${this.configuration.title}" ${path}`
    );
    this.logger("Sfo file generated.");
  }
  generatedSfoFile() {
    let sfoFilePath = `${os.tmpdir()}/param.sfo`;
    this.generateSfoFile(sfoFilePath);
    return gulp.src(sfoFilePath).pipe(rename('sce_sys/param.sfo'));
  }

  sourceFiles() {
    this.logger("Bundling source files...");
    return src(
      `${this.configuration.srcDir ?? defaults.config.srcDir ?? "src"
      }/**/*`
    );
  }

  srcFiles() {
    this.logger("Bundling source files.");
    return src([
      `${this.configuration.srcDir}/**/*`,
    ]);
  }

  processPipe(pipe: any){
    let f = filter(["**/*.{bmp,png,jpg}"], { restore: true });
    return pipe.pipe(f)
       .pipe(pngquant())
       .pipe(f.restore);
  }

  processedSrcFiles() {
    this.logger("Processing system and additional files.");
    return this.processPipe(this.srcFiles())
  }

  bundledFiles() {
    this.logger("Assembling project files...");
    return merge(
      this.generatedSfoFile(),
      this.processedSrcFiles()
    );
  }

  build() {
    return this.bundledFiles()
      .pipe(zip(`${this.configuration.title}.vpk`))
      .pipe(
        gulp.dest(this.configuration.outDir ?? defaults.config.outDir)
      );
  }

  async deployPipeAsync(pipe: any){
    this.logger("Bundling project files to temp directory.");
    await toPromise(pipe.pipe(gulp.dest(defaults.tempDir)));
    this.logger("Files bundled.");
    this.logger("Closing applications just in case.");
    await this.sendCmdAsync("destroy");
    let ftp = new Client();
    this.logger("Connecting to FTP server...");
    await ftp.access({
      host: this.configuration.ip ?? "localhost",
      port: this.configuration.ports?.ftp ?? defaults.config.ports?.ftp ?? 1337,
    });
    this.logger("Connected to FTP server.");
    // this.logger("Listing directories");
    // this.logger(await ftp.list());
    this.logger("Going to ux0: directory");
    await ftp.cd("ux0:");
    this.logger("Going to app directory");
    await ftp.cd("app");
    this.logger(`Going to ${this.configuration.id} directory`);
    await ftp.cd(this.configuration.id ?? defaults.config.id);
    this.logger("Uploading files...");
    await ftp.uploadFromDir(defaults.tempDir);
    this.logger("Files uploaded.");
    this.logger("Closing connection.");
    ftp.close();
    this.logger("Connection closed");
    this.logger("Opening application again");
    await this.sendCmdAsync(`launch ${this.configuration.id}`);
    this.logger("Opened application.");
    this.logger("Clearing temp directory");
    await this.clearTempDirectoryAsync();
    this.logger("Cleared temp directory.");
  }

  async deployAsync() {
    this.deployPipeAsync(this.processedSrcFiles());
  }
}

gulp.task("default", async () => {
  let project = new VitaProject();
  project.build();
});
gulp.task("build", async () => {
  let project = new VitaProject();
  project.build();
});

gulp.task("test:cmd", async () => {
  let project = new VitaProject();
  project.logger("Launching application...");
  await project.sendCmdAsync(`launch ${project.configuration.id}`);
  project.logger("Application launched.");
  project.logger("Waiting two seconds.");
  await sleepAsync(2000);
  project.logger("Destroying applications...");
  await project.sendCmdAsync("destroy");
  project.logger("Applications destroyed.");
});

gulp.task("deploy", async () => {
  let project = new VitaProject();
  await project.deployAsync();
});


gulp.task("watch", () => {
  /* TODO: Implement watch logic.
    Connect to device.
    Send the open application command. 
    Watch for the file changes inside project files.
      If it's a source file change, compile it or if it's a configuration file related change and if it's an image file, then process it.
      Close the application if it's opened.
      Connect to device through an FTP connection.
      Send these processed files to application directory via FTP.
      Close the FTP connection.
      Open the app again.
    Keep doing this until the process stops.
  */
  // I will be looking into this some time later because file watch partially works on WSL.
  // https://github.com/microsoft/WSL/issues/216
  let project = new VitaProject();
  function transferFiles(){
    project.logger("Transfer files called");
    return project.deployPipeAsync(
      project.processPipe(
        gulp.src([`${project.configuration.srcDir}/**/*`], { since: gulp.lastRun(transferFiles) })
      )
    );  
  }
  return gulp.watch([`${project.configuration.srcDir}/**/*`], transferFiles);
});