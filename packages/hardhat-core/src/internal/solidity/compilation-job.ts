import debug from "debug";
import type { LoDashStatic } from "lodash";
import semver from "semver";

import { SolcConfig, SolidityConfig } from "../../types";
import * as taskTypes from "../../types/builtin-tasks";
import {
  CompilationJobCreationError,
  CompilationJobCreationErrorReason,
  CompilationJobsCreationResult,
} from "../../types/builtin-tasks";
import { assertHardhatInvariant } from "../core/errors";

import { ResolvedFile } from "./resolver";

const log = debug("hardhat:core:compilation-job");

// this should have a proper version range when it's fixed
const SOLC_BUG_9573_VERSIONS = "*";

function isCompilationJobCreationError(
  x:
    | taskTypes.CompilationJob
    | taskTypes.CompilationJobCreationError
    | SolcConfig
): x is CompilationJobCreationError {
  return "reason" in x;
}

export class CompilationJob implements taskTypes.CompilationJob {
  private _filesToCompile: Map<
    string,
    { file: ResolvedFile; emitsArtifacts: boolean }
  > = new Map();

  constructor(public solidityConfig: SolcConfig) {}

  public addFileToCompile(file: ResolvedFile, emitsArtifacts: boolean) {
    const fileToCompile = this._filesToCompile.get(file.sourceName);

    // if the file doesn't exist, we add it
    // we also add it if emitsArtifacts is true, to override it in case it was
    // previously added but with a false emitsArtifacts
    if (fileToCompile === undefined || emitsArtifacts) {
      this._filesToCompile.set(file.sourceName, { file, emitsArtifacts });
    }
  }

  public hasSolc9573Bug(): boolean {
    return (
      this.solidityConfig?.settings?.optimizer?.enabled === true &&
      semver.satisfies(this.solidityConfig.version, SOLC_BUG_9573_VERSIONS)
    );
  }

  public merge(job: taskTypes.CompilationJob): CompilationJob {
    const { isEqual }: LoDashStatic = require("lodash");
    assertHardhatInvariant(
      isEqual(this.solidityConfig, job.getSolcConfig()),
      "Merging jobs with different solidity configurations"
    );
    const mergedJobs = new CompilationJob(job.getSolcConfig());
    for (const file of this.getResolvedFiles()) {
      mergedJobs.addFileToCompile(file, this.emitsArtifacts(file));
    }
    for (const file of job.getResolvedFiles()) {
      mergedJobs.addFileToCompile(file, job.emitsArtifacts(file));
    }
    return mergedJobs;
  }

  public getSolcConfig(): SolcConfig {
    return this.solidityConfig;
  }

  public isEmpty() {
    return this._filesToCompile.size === 0;
  }

  public getResolvedFiles(): ResolvedFile[] {
    return [...this._filesToCompile.values()].map((x) => x.file);
  }

  /**
   * Check if the given file emits artifacts.
   *
   * If no file is given, check if *some* file in the job emits artifacts.
   */
  public emitsArtifacts(file: ResolvedFile): boolean {
    const fileToCompile = this._filesToCompile.get(file.sourceName);

    assertHardhatInvariant(
      fileToCompile !== undefined,
      `File '${file.sourceName}' does not exist in this compilation job`
    );

    return fileToCompile.emitsArtifacts;
  }
}

function mergeCompilationJobs(
  jobs: taskTypes.CompilationJob[],
  isMergeable: (job: taskTypes.CompilationJob) => boolean
): taskTypes.CompilationJob[] {
  const { flatten }: LoDashStatic = require("lodash");

  const jobsMap: Map<SolcConfig, taskTypes.CompilationJob[]> = new Map();

  for (const job of jobs) {
    const mergedJobs = jobsMap.get(job.getSolcConfig());
    if (isMergeable(job)) {
      if (mergedJobs === undefined) {
        jobsMap.set(job.getSolcConfig(), [job]);
      } else if (mergedJobs.length === 1) {
        const newJob = mergedJobs[0].merge(job);
        jobsMap.set(job.getSolcConfig(), [newJob]);
      } else {
        assertHardhatInvariant(
          false,
          "More than one mergeable job was added for the same configuration"
        );
      }
    } else {
      if (mergedJobs === undefined) {
        jobsMap.set(job.getSolcConfig(), [job]);
      } else {
        jobsMap.set(job.getSolcConfig(), [...mergedJobs, job]);
      }
    }
  }

  return flatten([...jobsMap.values()]);
}

/**
 * Creates a list of compilation jobs from a dependency graph. *This function
 * assumes that the given graph is a connected component*.
 * Returns the list of compilation jobs on success, and a list of
 * non-compilable files on failure.
 */
export async function createCompilationJobsFromConnectedComponent(
  connectedComponent: taskTypes.DependencyGraph,
  getFromFile: (
    file: ResolvedFile
  ) => Promise<taskTypes.CompilationJob | CompilationJobCreationError>
): Promise<CompilationJobsCreationResult> {
  const compilationJobs: taskTypes.CompilationJob[] = [];
  const errors: CompilationJobCreationError[] = [];

  for (const file of connectedComponent.getResolvedFiles()) {
    const compilationJobOrError = await getFromFile(file);

    if (isCompilationJobCreationError(compilationJobOrError)) {
      log(
        `'${file.absolutePath}' couldn't be compiled. Reason: '${compilationJobOrError}'`
      );
      errors.push(compilationJobOrError);
      continue;
    }

    compilationJobs.push(compilationJobOrError);
  }

  const jobs = mergeCompilationJobsWithBug(compilationJobs);

  return { jobs, errors };
}

export async function createCompilationJobFromFile(
  dependencyGraph: taskTypes.DependencyGraph,
  file: ResolvedFile,
  solidityConfig: SolidityConfig
): Promise<CompilationJob | CompilationJobCreationError> {
  const directDependencies = dependencyGraph.getDependencies(file);
  const transitiveDependencies = dependencyGraph.getTransitiveDependencies(
    file
  );

  const compilerConfig = getCompilerConfigForFile(
    file,
    directDependencies,
    transitiveDependencies,
    solidityConfig
  );

  // if the config cannot be obtained, we just return the failure
  if (isCompilationJobCreationError(compilerConfig)) {
    return compilerConfig;
  }
  log(
    `File '${file.absolutePath}' will be compiled with version '${compilerConfig.version}'`
  );

  const compilationJob = new CompilationJob(compilerConfig);

  compilationJob.addFileToCompile(file, true);
  for (const dependency of transitiveDependencies) {
    log(
      `File '${dependency.absolutePath}' added as dependency of '${file.absolutePath}'`
    );
    compilationJob.addFileToCompile(dependency, false);
  }

  return compilationJob;
}

/**
 * Merge compilation jobs affected by the solc #9573 bug
 */
export function mergeCompilationJobsWithBug(
  compilationJobs: taskTypes.CompilationJob[]
): taskTypes.CompilationJob[] {
  return mergeCompilationJobs(compilationJobs, (job) => job.hasSolc9573Bug());
}

/**
 * Merge compilation jobs not affected by the solc #9573 bug
 */
export function mergeCompilationJobsWithoutBug(
  compilationJobs: taskTypes.CompilationJob[]
): taskTypes.CompilationJob[] {
  return mergeCompilationJobs(compilationJobs, (job) => !job.hasSolc9573Bug());
}

/**
 * Return the compiler config with the newest version that satisfies the given
 * version ranges, or a value indicating why the compiler couldn't be obtained.
 */
function getCompilerConfigForFile(
  file: ResolvedFile,
  directDependencies: ResolvedFile[],
  transitiveDependencies: ResolvedFile[],
  solidityConfig: SolidityConfig
): SolcConfig | CompilationJobCreationError {
  const { uniq }: LoDashStatic = require("lodash");

  const transitiveDependenciesVersionPragmas = transitiveDependencies.map(
    (x) => x.content.versionPragmas
  );
  const versionRange = uniq([
    ...file.content.versionPragmas,
    ...transitiveDependenciesVersionPragmas,
  ]).join(" ");

  const overrides = solidityConfig.overrides ?? {};

  const overriddenCompiler = overrides[file.sourceName];

  // if there's an override, we only check that
  if (overriddenCompiler !== undefined) {
    if (!semver.satisfies(overriddenCompiler.version, versionRange)) {
      return getCompilationJobCreationError(
        file,
        directDependencies,
        transitiveDependencies,
        [overriddenCompiler.version],
        true
      );
    }

    return overriddenCompiler;
  }

  // if there's no override, we find a compiler that matches the version range
  const compilerVersions = solidityConfig.compilers.map((x) => x.version);
  const matchingVersion = semver.maxSatisfying(compilerVersions, versionRange);

  if (matchingVersion === null) {
    return getCompilationJobCreationError(
      file,
      directDependencies,
      transitiveDependencies,
      compilerVersions,
      false
    );
  }

  const matchingConfig = solidityConfig.compilers.find(
    (x) => x.version === matchingVersion
  )!;

  return matchingConfig;
}

function getCompilationJobCreationError(
  file: ResolvedFile,
  directDependencies: ResolvedFile[],
  transitiveDependencies: ResolvedFile[],
  compilerVersions: string[],
  overriden: boolean
): CompilationJobCreationError {
  const fileVersionRange = file.content.versionPragmas.join(" ");
  if (semver.maxSatisfying(compilerVersions, fileVersionRange) === null) {
    const reason = overriden
      ? CompilationJobCreationErrorReason.INCOMPATIBLE_OVERRIDEN_SOLC_VERSION
      : CompilationJobCreationErrorReason.NO_COMPATIBLE_SOLC_VERSION_FOUND;
    return { reason, file };
  }

  const incompatibleImports: ResolvedFile[] = [];
  for (const dependency of directDependencies) {
    const dependencyVersionRange = dependency.content.versionPragmas.join(" ");
    if (!semver.intersects(fileVersionRange, dependencyVersionRange)) {
      incompatibleImports.push(dependency);
    }
  }

  if (incompatibleImports.length > 0) {
    return {
      reason: CompilationJobCreationErrorReason.IMPORTS_INCOMPATIBLE_FILE,
      file,
      extra: {
        incompatibleImports,
      },
    };
  }

  const incompatibleIndirectImports: ResolvedFile[] = [];
  for (const dependency of transitiveDependencies) {
    const dependencyVersionRange = dependency.content.versionPragmas.join(" ");
    if (!semver.intersects(fileVersionRange, dependencyVersionRange)) {
      incompatibleIndirectImports.push(dependency);
    }
  }

  if (incompatibleIndirectImports.length > 0) {
    return {
      reason:
        CompilationJobCreationErrorReason.INDIRECTLY_IMPORTS_INCOMPATIBLE_FILE,
      file,
      extra: {
        incompatibleIndirectImports,
      },
    };
  }

  return { reason: CompilationJobCreationErrorReason.OTHER_ERROR, file };
}
