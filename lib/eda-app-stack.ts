import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";

export class EDAAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imagesBucket = new s3.Bucket(this, "images", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false,
    });

    const badOrdersQueue = new sqs.Queue(this, "bad-orders-q", {
        retentionPeriod: Duration.minutes(30),
      });
  
      const ordersQueue = new sqs.Queue(this, "orders-queue", {
        deadLetterQueue: {
          queue: badOrdersQueue,
          // # of rejections by consumer (lambda function)
          maxReceiveCount: 2,
        },
      });
  


    // Integration infrastructure

    const imageProcessQueue = new sqs.Queue(this, "img-created-queue", {
      receiveMessageWaitTime: cdk.Duration.seconds(10),
    });

    const mailerQ = new sqs.Queue(this, "mailer-queue", {
      receiveMessageWaitTime: cdk.Duration.seconds(10),
    });

    const newImageTopic = new sns.Topic(this, "NewImageTopic", {
      displayName: "New Image topic",
    });

    // Lambda functions

    const processImageFn = new lambdanode.NodejsFunction(
      this,
      "ProcessImageFn",
      {
        // architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: `${__dirname}/../lambdas/processImage.ts`,
        timeout: cdk.Duration.seconds(15),
        memorySize: 128,
      }
    );

    const processOrdersFn = new NodejsFunction(this, "ProcessOrdersFn", {
        architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: `${__dirname}/../lambdas/processOrders.ts`,
        timeout: Duration.seconds(10),
        memorySize: 128,
      });

      // VVV For testing
      const generateOrdersFn = new NodejsFunction(this, "GenerateOrdersFn", {
        architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: `${__dirname}/../lambdas/generateOrders.ts`,
        timeout: Duration.seconds(10),
        memorySize: 128,
        environment: {
          QUEUE_URL: ordersQueue.queueUrl,
        },
      });

      const failedOrdersFn = new NodejsFunction(this, "FailedOrdersFn", {
        architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: `${__dirname}/../lambdas/handleBadOrder.ts`,
        timeout: Duration.seconds(10),
        memorySize: 128,
      });

    const mailerFn = new lambdanode.NodejsFunction(this, "mailer-function", {
      runtime: lambda.Runtime.NODEJS_16_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(3),
      entry: `${__dirname}/../lambdas/mailer.ts`,
    });

    newImageTopic.addSubscription(new subs.SqsSubscription(mailerQ));
    newImageTopic.addSubscription(new subs.SqsSubscription(imageProcessQueue));

    // Event triggers

    imagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SnsDestination(newImageTopic)
    );

    const newImageEventSource = new events.SqsEventSource(imageProcessQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(10),
    });

    const newImageMailEventSource = new events.SqsEventSource(mailerQ, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(10),
    });

    processOrdersFn.addEventSource(
        new SqsEventSource(ordersQueue, {
          maxBatchingWindow: Duration.seconds(5),
          maxConcurrency: 2,
        })
      );
  
      failedOrdersFn.addEventSource(
        new SqsEventSource(badOrdersQueue, {
          maxBatchingWindow: Duration.seconds(5),
          maxConcurrency: 2,
        })
      );

    mailerFn.addEventSource(newImageMailEventSource);

    processImageFn.addEventSource(newImageEventSource);

    imagesBucket.grantRead(processImageFn);

    ordersQueue.grantSendMessages(generateOrdersFn)

    mailerFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:SendTemplatedEmail",
        ],
        resources: ["*"],
      })
    );

    // Output

    new cdk.CfnOutput(this, "bucketName", {
      value: imagesBucket.bucketName,
    });

    new CfnOutput(this, "Generator Lambda name", {
        value: generateOrdersFn.functionName,
      });

  }
}
