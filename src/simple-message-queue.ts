/*
  A simpe messages queue for IBM's Node-Red
  https://github.com/shady2k/node-red-contrib-simple-message-queue
  (c) 2017, shady2k <shady2k@gmail.com>
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
  http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import {
  Node,
  NodeAPI,
  NodeContext,
  NodeDef,
  NodeMessageInFlow,
} from "node-red";

interface nodeConfig extends NodeDef {
  firstMessageBypass: boolean;
  backupMessages: boolean;
  bypassInterval: number;
  maxMsgLimit: number;
}

interface nodeMsg extends NodeMessageInFlow {
  _queueCount?: number; // Stores the Current Queue Count of Msgs
  queueCount?: boolean; // Flag to set QueueCount in  messages or not
  reset?:boolean; // Reset the queue
  bypassInterval?: string;  // 
  bypass?: boolean;
  trigger?: boolean;
  req_failed?: boolean;
  _queuetimestamp?: any; // Will be time stamp
  ttl?: string;
}

interface nodeContext extends Partial<NodeContext> {
  queue: nodeMsg[];
  backup_queue?: nodeMsg[];
  is_disabled?: boolean;
  capacity?: number;
}

module.exports = function (RED: NodeAPI) {
  function isNormalInteger(str: string) {
    return /^\+?(0|[1-9]\d*)$/.test(str);
  }

  function setBusyFalse(smq: any) {
    clearTimeout(smq.bypassTimer);
    smq.bypassTimer = null;
    smq.isBusy = false;
  }

  function bypassQueue(smq: any, context: nodeContext, node: Node) {
    if (
      smq.bypassInterval > 0 &&
      context.queue.length > 0 &&
      !smq.bypassTimer
    ) {
      smq.bypassTimer = setTimeout(function bypassSend() {
        smq.bypassTimer = null;
        let m = context.queue.shift();
        if (m) {
          m["_queueCount"] = context.queue.length;
          node.send([m, null]);

          if (context.queue.length == 0) {
            smq.isBusy = false;
          }

          if (context.queue.length > 0) {
            smq.bypassTimer = setTimeout(bypassSend, smq.bypassInterval);
          }

          // Update status
          node.status({
            fill: "green",
            shape: "ring",
            text: `${context.queue.length}`,
          });
        } else {
          smq.bypassTimer = null;
          smq.isBusy = false;
        }
      }, smq.bypassInterval);
    }
  }

  function stopBypassTimer(smq: any) {
    clearTimeout(smq.bypassTimer);
    smq.bypassTimer = null;
  }

  function SimpleMessageQueueNode(this: Node, config: nodeConfig) {
    RED.nodes.createNode(this, config);
    let smq = {
      firstMessageBypass: config.firstMessageBypass || false,
      bypassInterval: config.bypassInterval || 0,
      backupMessages: config.backupMessages || false,
      maxMsgLimit: config.maxMsgLimit || 0,
      isBusy: false,
      bypassTimer: null,
    };
    var node = this;

    // Yes it's true: an incoming message just happened

    this.on("input", function (msg: nodeMsg, nodeSend, nodeDone) {
      let now = Date.now;

      let context = node.context() as nodeContext;

      // if queue doesn't exist, create it
      context.queue = context.queue || [];
      context.backup_queue = context.backup_queue || [];
      context.is_disabled = context.is_disabled || false;
      context.capacity = smq.maxMsgLimit;

      // if the msg is a reset, clear queue
      if (msg.reset !== undefined) {
        context.queue = [];
        context.backup_queue = [];
        setBusyFalse(smq);
      } else if (msg.queueCount !== undefined) {
        msg["_queueCount"] = context.queue.length;
        node.send([msg, null]);
        // } else if (msg.hasOwnProperty("set_capacity")) {
        // 	context.capacity = msg.set_capacity;
        // 	node.send([msg,null]);
      } else if (msg.bypassInterval !== undefined) {
        let re = /^\+?(0|[1-9]\d*)$/;
        if (re.test(msg.bypassInterval)) {
          smq.bypassInterval = +msg.bypassInterval; //convert from string to number
        }
      } else if (msg.bypass !== undefined) {
        if (msg.bypass) {
          context.is_disabled = true;
        } else {
          context.is_disabled = false;
          setBusyFalse(smq);
          //context.queue = [];
        }
      } else if (msg.req_failed !== undefined) {
        // Push 1 backup msg into main queue again
        // console.log(context.backup_queue)
        let last_elem = context.backup_queue.shift();
        if (last_elem) {
          context.queue.push(last_elem);
        } else {
          return nodeDone();
        }
      } else if (msg.trigger !== undefined) {
        // if the msg is a trigger one release next message
        // Filter overdue messages
        context.queue = context.queue.filter(function (x) {
          if (x.ttl) return now() - x._queuetimestamp < +x.ttl || +x.ttl == 0;
          return true;
        });

        let last_elem = context.queue.shift();
        if (last_elem) {
          if (smq.backupMessages) context.backup_queue.push(last_elem);
          last_elem["_queueCount"] = context.queue.length;

          node.send([last_elem, null]);
          stopBypassTimer(smq);
          bypassQueue(smq, context, node);
        } else {
          setBusyFalse(smq);
        }
      } else {
        if (context.is_disabled || (smq.firstMessageBypass && !smq.isBusy)) {
          smq.isBusy = true;
          msg["_queueCount"] = context.queue.length;
          node.send([msg, null]);
          stopBypassTimer(smq);
          bypassQueue(smq, context, node);
        } else {
          if (
            context.capacity <= context.queue.length &&
            context.capacity > 0
          ) {
            // 0 means no limit
            node.status({
              fill: "yellow",
              shape: "ring",
              text: `${context.queue.length}`,
            });
            nodeSend([null, msg]);
            return nodeDone();
          }

          // Check if ttl value of new message is positive integer
          if (msg.ttl) {
            if (!isNormalInteger(msg.ttl)) msg.ttl = "0";
          }
          msg._queuetimestamp = now();
          context.queue.push(msg); // Add to queue

          // Filter overdue messages
          context.queue = context.queue.filter(function (x) {
            if (x.ttl) return now() - x._queuetimestamp < +x.ttl || +x.ttl == 0;
            return true;
          });
        }
      }
      console.log("Reached");
      bypassQueue(smq, context, node);
      // Update status
      node.status({
        fill: "green",
        shape: "ring",
        text: `${context.queue.length}`,
      });
      // nodeSend(msg)
      nodeDone();
    });

    this.on("close", function () {
      // Update status
      node.status({ fill: "green", shape: "ring", text: "0" });
    });
  }

  RED.nodes.registerType("cgpl-queue", SimpleMessageQueueNode);
};
