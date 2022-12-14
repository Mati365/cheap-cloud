import * as path from "path";
import * as fs from "fs";

import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";

import {
  ensureDirIsEmpty,
  isPortReachable,
  resolveDistPath,
  resolveProjectAnsiblePath,
} from "@infra/shared";

import { AppCluster } from "./create-skeleton-cluster";

type ConfigureClusterConfig = {
  env: string;
  cluster: AppCluster;
  force?: boolean;
};

export const ansibleConfigureCluster = ({
  env,
  force,
  cluster: { nodes, privateNetwork },
}: ConfigureClusterConfig) => {
  const inventory = pulumi.interpolate`
    [server]
    ${nodes.server.ipv4Address}

    [client]
    ${nodes.client.ipv4Address}

    [cluster:children]
    server
    client

    [web:children]
    cluster
  `;

  const groupVars = pulumi.interpolate`
    env: ${env}
    cluster_cidr: "${privateNetwork.ipv4.subNetworks[0]}"

    addresses:
      server: ${privateNetwork.ipv4.server}
      registry: ${privateNetwork.ipv4.server}
      nfs_server: ${privateNetwork.ipv4.server}
      dns_server: ${privateNetwork.ipv4.server}
      consul:
        ip: ${privateNetwork.ipv4.server}
        port: 8500
        dns_port: 8600
        stats_port: 3000
  `;

  const clusterAvailable = nodes.server.ipv4Address.apply((ip) =>
    pulumi.output(isPortReachable(8200, { host: ip }))
  );

  return pulumi
    .all([inventory, groupVars, clusterAvailable])
    .apply(([inventory, groupVars, clusterAvailable]) => {
      const resolveInventoryPath = (file: string = "") =>
        resolveDistPath(path.join("ansible", "inventory", file));

      const inventoryHostsPath = resolveInventoryPath("hosts.ini");
      const groupVarsPath = resolveInventoryPath("group_vars/all.yml");

      ensureDirIsEmpty(resolveInventoryPath());
      ensureDirIsEmpty(resolveInventoryPath("group_vars"));

      fs.writeFileSync(inventoryHostsPath, inventory, "utf-8");
      fs.writeFileSync(groupVarsPath, groupVars, "utf-8");

      const ansiblePath = resolveProjectAnsiblePath();
      const playbookPath = resolveProjectAnsiblePath("configure.yml");

      console.info(
        `cd ${ansiblePath}; ansible-playbook ${playbookPath} -i ${inventoryHostsPath}`
      );

      return new local.Command(`Ansible sync config (ver: ${Date.now()})`, {
        create:
          clusterAvailable && !force
            ? "/bin/true"
            : `cd ${ansiblePath}; ansible-playbook ${playbookPath} -i ${inventoryHostsPath}`,
      });
    });
};
