import { JsonConvert } from 'json2typescript';
import * as R from 'ramda';

import * as Comments from 'features/comments';
import { BaseDataService } from 'core/services/BaseDataService';
import { IArtifact } from 'core/shared/models/Artifact';
import {
  IFilterData,
  PropertyType,
  ComparisonType,
} from 'core/features/filter/Model';
import { IPagination, DataWithPagination } from 'core/shared/models/Pagination';
import { ISorting } from 'core/shared/models/Sorting';
import { ShortExperiment } from 'models/Experiment';
import ModelRecord, {
  LoadExperimentRunErrorType,
  IVersionedInputs,
} from 'models/ModelRecord';
import User from 'models/User';
import {
  convertServerCodeVersion,
  convertServerCodeVersionsFromBlob,
} from 'services/serverModel/CodeVersion/converters';
import { convertServerEntityWithLoggedDates } from 'services/serverModel/Common/converters';

import { convertServerUser } from '../../core/services/serverModel/User/converters';
import makeLoadExperimentRunsRequest, {
} from './responseRequest/makeLoadExperimentRunsRequest';
import {
  ILoadExperimentRunsResult,
  ILoadModelRecordResult,
  ILazyLoadChartData,
} from './types';
import { IWorkspace } from 'models/Workspace';
import { RepositoriesDataService } from 'core/services/versioning/repositories';

export const chartsPageSettings = {
  pageSize: 50,
  datapointLimit: 500,
};

export default class ExperimentRunsDataService extends BaseDataService {
  constructor() {
    super();
  }

  public async loadExperimentRuns(
    projectId: string,
    filters: IFilterData[] = [],
    pagination: IPagination,
    sorting: ISorting | null
  ): Promise<ILoadExperimentRunsResult> {
    const request = await makeLoadExperimentRunsRequest(
      projectId,
      filters,
      pagination,
      sorting
    );
    const response = await this.post({
      url: '/v1/modeldb/hydratedData/findHydratedExperimentRuns',
      data: request,
    });

    const data = await this.convertExperimentRuns(response.data);

    const res: ILoadExperimentRunsResult = {
      data,
      totalCount: Number(response.data.total_records || 0),
    };
    return res;
  }

  public async loadExperimentRunsByIds(
    projectId: string,
    experimentRunsIds: string[]
  ): Promise<ModelRecord[]> {
    if (experimentRunsIds.length === 0) {
      return Promise.resolve([]);
    }
    const response = await this.post({
      url: '/v1/modeldb/hydratedData/findHydratedExperimentRuns',
      data: {
        project_id: projectId,
        experiment_run_ids: experimentRunsIds,
      },
    });

    const data = await this.convertExperimentRuns(response.data);

    return data.map(({ experimentRun }) => experimentRun);
  }

  public async lazyLoadChartData(
    projectId: string,
    filters: IFilterData[] = []
  ): Promise<ILazyLoadChartData> {
    const sorting = null;
    const paginationInitialLoad: IPagination = {
      currentPage: 0,
      pageSize: chartsPageSettings.pageSize,
      totalCount: 0,
    };

    return makeLoadExperimentRunsRequest(
      projectId,
      filters,
      paginationInitialLoad,
      sorting
    ).then(request => {
      let totalCount = 0;
      return this.post({
        url: '/v1/modeldb/hydratedData/findHydratedExperimentRuns',
        data: request,
      })
        .then(serverResponse => {
          totalCount = serverResponse.data.total_records;
          return this.convertExperimentRuns(serverResponse.data);
        })
        .then(response => {
          const res: ILazyLoadChartData = {
            lazyChartData: response.map(({ experimentRun }) => experimentRun),
            totalCount,
          };
          return res;
        });
    });
  }

  public async loadModelRecord(
    modelId: string
  ): Promise<ILoadModelRecordResult> {
    const response = await this.get<any, LoadExperimentRunErrorType>({
      url: '/v1/modeldb/hydratedData/getHydratedExperimentRunById',
      config: { params: { id: modelId } },
      errorConverters: {
        accessDeniedToEntity: ({ status }) => status === 403,
        entityNotFound: ({ status }) => status === 404,
      },
    });

    return await convertServerExperimentRun(
      response.data.hydrated_experiment_run
    );
  }

  public async deleteExperimentRun(id: string): Promise<void> {
    await this.delete({
      url: '/v1/modeldb/experiment-run/deleteExperimentRun',
      config: { data: { id } },
    });
  }

  public async deleteExperimentRuns(ids: string[]): Promise<void> {
    await this.delete({
      url: '/v1/modeldb/experiment-run/deleteExperimentRuns',
      config: { data: { ids } },
    });
  }

  public async loadArtifactUrl(
    experimentRunId: string,
    artifact: IArtifact
  ): Promise<string> {
    const response = await this.post({
      url: '/v1/modeldb/experiment-run/getUrlForArtifact',
      data: {
        id: experimentRunId,
        key: artifact.key,
        artifact_type: artifact.type,
        method: 'GET',
      },
    });
    return response.data.url;
  }

  public async deleteArtifact(
    experimentRunId: string,
    artifactKey: string
  ): Promise<void> {
    await this.delete({
      url: '/v1/modeldb/experiment-run/deleteArtifact',
      config: {
        data: {
          id: experimentRunId,
          key: artifactKey,
        },
      },
    });
  }

  public async loadExperimentRunsByDatasetVersionId(
    workspaceName: IWorkspace['name'],
    datasetVersionId: string
  ): Promise<DataWithPagination<ModelRecord>> {
    const {
      data: { projects: serverProjects },
    } = await this.get<{ projects: Array<{ id: string }> }>({
      url: `/v1/modeldb/project/getProjects?workspace_name=${workspaceName}`,
    });
    const experimentRunsByProjects = await Promise.all(
      (serverProjects || []).map(({ id }) =>
        this.loadExperimentRuns(
          id,
          [
            {
              type: PropertyType.METRIC,
              id: '-1',
              comparisonType: ComparisonType.EQUALS,
              name: 'datasets.linked_artifact_id',
              value: datasetVersionId as any,
            },
          ],
          { currentPage: 0, pageSize: 1000, totalCount: 0 },
          null
        )
      )
    );
    const res: DataWithPagination<ModelRecord> = {
      data: R.chain(
        projectExperimentRuns => projectExperimentRuns.data,
        experimentRunsByProjects
      ).map(({ experimentRun }) => experimentRun),
      totalCount: experimentRunsByProjects
        .map(({ totalCount }) => totalCount)
        .reduce(R.add),
    };
    return res;
  }

  private async convertExperimentRuns(
    data: any,
    withLoadingVersionedInputs: boolean = true
  ) {
    if (!data.hydrated_experiment_runs) {
      return [];
    }
    return await Promise.all(
      (data.hydrated_experiment_runs as any[]).map(x =>
        convertServerExperimentRun(x, withLoadingVersionedInputs)
      )
    );
  }
}

const convertServerExperimentRun = async (
  hydrated_experiment_run: any,
  withLoadingVersionedInputs: boolean = true
) => {
  const jsonConvert = new JsonConvert();
  const modelRecord = jsonConvert.deserializeObject(
    hydrated_experiment_run.experiment_run,
    ModelRecord
  );
  modelRecord.shortExperiment = (() => {
    const shortExperiment = jsonConvert.deserializeObject(
      hydrated_experiment_run.experiment,
      ShortExperiment
    ) as ShortExperiment;
    shortExperiment.id = modelRecord.experimentId;
    return shortExperiment;
  })();
  modelRecord.owner = convertServerUser(
    hydrated_experiment_run.owner_user_info
  );

  modelRecord.codeVersion = convertServerCodeVersion(
    hydrated_experiment_run.experiment_run.code_version_snapshot
  );
  modelRecord.codeVersionsFromBlob = hydrated_experiment_run.experiment_run
    .code_version_from_blob
    ? convertServerCodeVersionsFromBlob(
        hydrated_experiment_run.experiment_run.code_version_from_blob
      )
    : undefined;

  if (
    withLoadingVersionedInputs &&
    hydrated_experiment_run.experiment_run.versioned_inputs
  ) {
    const versionedInputs = await (async () => {
      try {
        const serverVersionedInputs =
          hydrated_experiment_run.experiment_run.versioned_inputs;
        const repositoryName = await new RepositoriesDataService().loadRepositoryName(
          serverVersionedInputs.repository_id
        );
        return {
          commitSha: serverVersionedInputs.commit,
          repositoryId: serverVersionedInputs.repository_id,
          repositoryName: repositoryName,
          keyLocationMap: serverVersionedInputs.key_location_map,
        };
      } catch (e) {
        return undefined;
      }
    })();
    modelRecord.versionedInputs = versionedInputs;
  }

  modelRecord.allowedActions = [];

  const dates = convertServerEntityWithLoggedDates(
    hydrated_experiment_run.experiment_run
  );
  modelRecord.dateCreated = dates.dateCreated;
  modelRecord.dateUpdated = dates.dateUpdated;

  const result: ILoadModelRecordResult = {
    experimentRun: modelRecord,
    comments: (hydrated_experiment_run.comments || []).map((comment: any) =>
      Comments.convertServerComment(
        comment,
      )
    ),
  };
  return result;
};
