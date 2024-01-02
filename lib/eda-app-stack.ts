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
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import * as dynamoDB from "aws-cdk-lib/aws-dynamodb"

export class EDAAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imageTable = new dynamoDB.Table(this, "ImagesTable", {
        billingMode: dynamoDB.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: "ImageName", type: dynamoDB.AttributeType.STRING },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        tableName: "Images",
  });

    const imagesBucket = new s3.Bucket(this, "images", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false,
    });

    const eventsTopic = new sns.Topic(this, "eventsTopic", {
        displayName: "Events Topic",
      });

    // Creating Dead Letter Queue for Rejection Email
  const rejectionQueue = new sqs.Queue(this, "RejectionEmailDLQ",{ queueName:"RejectionEmailDLQ" });

  const imageProcessQueue = new sqs.Queue(this, "img-created-queue", {
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        queue: rejectionQueue,
        maxReceiveCount: 2
      },
      retentionPeriod: cdk.Duration.seconds(60)
    });

    const processImageFn = new lambdanode.NodejsFunction(
      this,
      "ProcessImageFn",
      {
        // architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: `${__dirname}/../lambdas/processImage.ts`,
        timeout: cdk.Duration.seconds(15),
        memorySize: 128,
        deadLetterQueue: rejectionQueue,
      }
    );

    const confirmationMailerFn = new lambdanode.NodejsFunction(this, "confirmationMailFn", {
        architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: `${__dirname}/../lambdas/confirmationMailer.ts`,
        timeout: Duration.seconds(10),
        memorySize: 1024
    });

    const rejectionMailerFn = new lambdanode.NodejsFunction(this, "rejectionMailFn", {
        architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_16_X,
        entry: `${__dirname}/../lambdas/rejectionMailer.ts`,
        timeout: Duration.seconds(10),
        memorySize: 1024
    });

    eventsTopic.addSubscription(
        new subs.LambdaSubscription(confirmationMailerFn));
  
    eventsTopic.addSubscription(
        new subs.SqsSubscription(imageProcessQueue) 
      );
    
    // Event triggers

    imagesBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.SnsDestination(eventsTopic)
      );
  
    imagesBucket.addEventNotification(
        s3.EventType.OBJECT_REMOVED,
        new s3n.SnsDestination(eventsTopic)
      );

    const newImageEventSource = new events.SqsEventSource(imageProcessQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(10),
      });
  
  
    const newRejectionEventSource = new events.SqsEventSource(rejectionQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(10),
        maxConcurrency: 5
      });

    processImageFn.addEventSource(newImageEventSource);
    rejectionMailerFn.addEventSource(newRejectionEventSource)

    imagesBucket.grantRead(processImageFn);
    imageTable.grantReadWriteData(processImageFn);

    confirmationMailerFn.addToRolePolicy(
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
  
      rejectionMailerFn.addToRolePolicy(
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

  }
}
